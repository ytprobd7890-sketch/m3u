#!/usr/bin/env python3
"""
build_playlist.py
-----------------
Fetches the original jstar.m3u playlist and converts every JioTV direct URL
into a worldwide-accessible proxied URL (via mini.allinonereborn.site).

- Rewrites hosts:
    https://jiotvmblive.cdn.jio.com/bpk-tv/{name}/WDVLive/index.mpd
      -> https://mini.allinonereborn.site/jtv-plus/jtv.php/{name}/WDVLive/index.mpd

    https://jiotvmblive.cdn.jio.com/{name}/{name}.m3u8
      -> https://mini.allinonereborn.site/jtv-plus/jtv.php/{name}/{name}.m3u8

- Removes the useless `&xxx=%7Ccookie=...` suffix.
- Injects browser-style headers (User-Agent, Referer, Origin) so the proxy
  accepts the request. These are emitted in three formats so Kodi /
  InputStream Adaptive, VLC, and Tivimate / OTT Navigator all pick them up.
- Preserves multi-key JWK ClearKey blocks exactly as they appear.

Outputs:
  output/worldwide.m3u          - the playlist itself
  output/worldwide.json         - structured channel list (one obj per channel)
  output/worldwide.stats.json   - build stats
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

import requests

# ------------------------------------------------------------------ config

SOURCE_URL = os.environ.get(
    "SOURCE_URL",
    "https://alex4528.site/playlist/jstar.m3u",
)
OUT_DIR    = Path(os.environ.get("OUT_DIR", "output"))
M3U_FILE   = OUT_DIR / "worldwide.m3u"
JSON_FILE  = OUT_DIR / "worldwide.json"
STATS_FILE = OUT_DIR / "worldwide.stats.json"

# The proxy the jtvxweb site fronts JioTV with:
PROXY_HOST = "mini.allinonereborn.site"
PROXY_PATH = "/jtv-plus/jtv.php"

# Headers the proxy demands (verified via live probing):
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
REFERER = "https://jtvxweb.pages.dev/"
ORIGIN  = "https://jtvxweb.pages.dev"

# Direct-JioTV host prefixes we rewrite -> proxy.
HOST_REWRITES = {
    "https://jiotvmblive.cdn.jio.com/bpk-tv/":  f"https://{PROXY_HOST}{PROXY_PATH}/",
    "https://jiotvmblive.cdn.jio.com/":         f"https://{PROXY_HOST}{PROXY_PATH}/",
    "https://jiotvbpklive.cdn.jio.com/bpk-tv/": f"https://{PROXY_HOST}{PROXY_PATH}/",
    "https://jiotvbpklive.cdn.jio.com/":        f"https://{PROXY_HOST}{PROXY_PATH}/",
    "https://jiotvpllive.cdn.jio.com/bpk-tv/":  f"https://{PROXY_HOST}{PROXY_PATH}/",
    "https://jiotvpllive.cdn.jio.com/":         f"https://{PROXY_HOST}{PROXY_PATH}/",
    "https://jiotvvod.cdn.jio.com/bpk-tv/":     f"https://{PROXY_HOST}{PROXY_PATH}/",
    "https://jiotvvod.cdn.jio.com/":            f"https://{PROXY_HOST}{PROXY_PATH}/",
}

# ------------------------------------------------------------------ helpers

def fetch_source(url: str) -> str:
    print(f"[+] Fetching source: {url}")
    r = requests.get(
        url,
        timeout=60,
        headers={"User-Agent": BROWSER_UA, "Accept": "*/*"},
    )
    r.raise_for_status()
    text = r.text
    print(f"[+] Got {len(text):,} bytes")
    return text


def clean_url(u: str) -> str:
    """Strip the redundant `&xxx=%7Ccookie=...` blob that the source appends."""
    u = re.sub(r"&xxx=(%7C|\|).*$", "", u)
    return u.strip()


def rewrite_url(u: str) -> Optional[str]:
    """Return proxied URL, or None if we can't (or don't need to) rewrite."""
    u = clean_url(u)
    for src, dst in HOST_REWRITES.items():
        if u.startswith(src):
            return dst + u[len(src):]
    return None  # leave non-JioTV URLs alone


# --- attribute + license extraction ---

ATTR_RE = re.compile(r'([a-zA-Z0-9_-]+)="([^"]*)"')

def parse_extinf(line: str) -> tuple[dict, str]:
    """
    #EXTINF:-1 tvg-id="X" tvg-logo="Y" group-title="Z", Channel Name
      -> ({'tvg-id': 'X', 'tvg-logo': 'Y', 'group-title': 'Z'}, 'Channel Name')
    """
    attrs = dict(ATTR_RE.findall(line))
    # name = everything after the last comma before newline
    name = ""
    if "," in line:
        name = line.split(",", 1)[1].strip()
    return attrs, name


def parse_license_key(line: str) -> Optional[dict]:
    """
    Extract KODIPROP inputstream.adaptive.license_key value.
    Supports both:
      - JSON JWK: {"keys":[{"kty":"oct","kid":"...","k":"..."}], "type":"temporary"}
      - Shortform: KID:KEY   (hex)
    Returns a normalised dict, or None.
    """
    m = re.match(r"#KODIPROP:inputstream\.adaptive\.license_key=(.+)$", line, re.I)
    if not m:
        return None
    raw = m.group(1).strip()
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            return {"format": "jwk", "raw": raw, "data": data}
        except json.JSONDecodeError:
            return {"format": "jwk_broken", "raw": raw}
    if ":" in raw:
        kid, key = raw.split(":", 1)
        return {"format": "kid_key_hex", "raw": raw,
                "kid": kid.strip(), "key": key.strip()}
    return {"format": "unknown", "raw": raw}


# ------------------------------------------------------------------ core

BLOCK_LINE_RE = re.compile(r"^(#EXTINF|#EXTVLCOPT|#EXTHTTP|#KODIPROP)", re.I)


def transform(source_text: str) -> tuple[str, list[dict], dict]:
    """Parse the source M3U into channel objects, and re-emit as an M3U."""
    lines = source_text.splitlines()

    # M3U output header
    m3u: list[str] = [
        '#EXTM3U x-tvg-url=""',
        f'# Generated {time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())}',
        f'# Source : {SOURCE_URL}',
        f'# Proxy  : https://{PROXY_HOST}{PROXY_PATH}',
        '',
    ]

    channels: list[dict] = []
    total = converted = passed_through = skipped = 0
    current: list[str] = []

    for raw in lines:
        line = raw.rstrip("\r\n")
        if not line.strip():
            continue

        if line.startswith("#EXTM3U"):
            continue

        if BLOCK_LINE_RE.match(line) or line.startswith("#"):
            current.append(line)
            continue

        # URL line closes a channel block
        url_line = line.strip()
        total += 1

        new_url = rewrite_url(url_line)
        if new_url is None:
            if url_line.startswith(("http://", "https://")):
                new_url = clean_url(url_line)
                passed_through += 1
                converted_flag = False
            else:
                skipped += 1
                current = []
                continue
        else:
            converted += 1
            converted_flag = True

        # extract channel metadata for JSON
        extinf_line = next((c for c in current if c.startswith("#EXTINF")), "")
        attrs, name = parse_extinf(extinf_line)

        license_info = None
        for c in current:
            li = parse_license_key(c)
            if li:
                license_info = li
                break

        # extract cookie from #EXTHTTP if present
        cookie = None
        for c in current:
            mm = re.match(r"#EXTHTTP:(.+)$", c)
            if mm:
                try:
                    hobj = json.loads(mm.group(1))
                    if isinstance(hobj, dict) and "cookie" in hobj:
                        cookie = hobj["cookie"]
                except Exception:
                    pass

        # __hdnea__ token from URL (nice to expose in JSON)
        tok = re.search(r"__hdnea__=([^&]+)", new_url)
        token = tok.group(1) if tok else None

        ch = {
            "name":       name or attrs.get("tvg-name", ""),
            "tvg_id":     attrs.get("tvg-id", ""),
            "logo":       attrs.get("tvg-logo", ""),
            "group":      attrs.get("group-title", "Unknown"),
            "url":        new_url,
            "original_url_host_replaced": converted_flag,
            "manifest_type": "mpd" if ".mpd" in new_url else ("hls" if ".m3u8" in new_url else "other"),
            "license":    license_info,
            "cookie":     cookie,
            "token":      token,
            "headers": {
                "User-Agent": BROWSER_UA,
                "Referer":    REFERER,
                "Origin":     ORIGIN,
            },
        }
        channels.append(ch)

        # --- emit into M3U ---
        # Keep ONLY:
        #   - #EXTINF
        #   - #KODIPROP:inputstream.adaptive.license_key (DRM keys)
        # Drop everything else from source (old @alex_vault UA, cookie EXTHTTP, etc.)
        for cl in current:
            if cl.startswith("#EXTINF"):
                m3u.append(cl)
            elif cl.startswith("#KODIPROP:inputstream.adaptive.license_key"):
                m3u.append(cl)
            # else: skip — replaced by our own headers below

        # For DASH streams, tell InputStream Adaptive to use MPD parser
        if ".mpd" in new_url:
            m3u.append("#KODIPROP:inputstream.adaptive.manifest_type=mpd")

        # The three headers the proxy actually needs — nothing more, nothing less
        hdrs = (
            f"User-Agent={BROWSER_UA}&"
            f"Referer={REFERER}&"
            f"Origin={ORIGIN}"
        )
        m3u.append(f"#KODIPROP:inputstream.adaptive.manifest_headers={hdrs}")
        m3u.append(f"#KODIPROP:inputstream.adaptive.stream_headers={hdrs}")

        m3u.append(new_url)
        m3u.append("")
        current = []

    stats = {
        "generated_at":   int(time.time()),
        "generated_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source":         SOURCE_URL,
        "proxy":          f"https://{PROXY_HOST}{PROXY_PATH}",
        "total_channels": total,
        "converted":      converted,
        "passed_through": passed_through,
        "skipped":        skipped,
    }
    print(f"[+] Total: {total}  converted: {converted}  "
          f"passthrough: {passed_through}  skipped: {skipped}")
    return "\n".join(m3u) + "\n", channels, stats


# ------------------------------------------------------------------ main

def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    try:
        src = fetch_source(SOURCE_URL)
    except Exception as e:
        print(f"[!] Failed to fetch source: {e}", file=sys.stderr)
        return 2

    if "#EXTINF" not in src:
        print("[!] Source doesn't look like an M3U (no #EXTINF found)",
              file=sys.stderr)
        return 3

    playlist, channels, stats = transform(src)

    M3U_FILE.write_text(playlist, encoding="utf-8")
    JSON_FILE.write_text(
        json.dumps(
            {"meta": stats, "channels": channels},
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    STATS_FILE.write_text(json.dumps(stats, indent=2), encoding="utf-8")

    print(f"[+] Wrote {M3U_FILE}   ({len(playlist):,} bytes)")
    print(f"[+] Wrote {JSON_FILE}  ({JSON_FILE.stat().st_size:,} bytes, "
          f"{len(channels)} channels)")
    print(f"[+] Wrote {STATS_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
