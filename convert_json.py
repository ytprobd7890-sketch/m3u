import os
import json
import base64
import requests
from urllib.parse import urlparse

# Configuration
JSON_URL = "https://jtvxweb.pages.dev/den-ww.json"
SERVER_URL = os.environ.get("SERVER_URL", "https://m3u-production.up.railway.app")
OUTPUT_M3U = "output/jtvplusww.m3u"

# Ensure output directory exists
os.makedirs("output", exist_ok=True)

def hex_to_base64url(hex_str):
    """Converts a Hex-encoded string into a Base64URL-encoded string without padding."""
    try:
        hex_str = hex_str.strip().replace("-", "")
        binary = bytes.fromhex(hex_str)
        b64 = base64.urlsafe_b64encode(binary).decode('utf-8')
        return b64.rstrip('=')
    except Exception:
        return ""

def main():
    print(f"[+] Fetching live JSON database from: {JSON_URL}")
    try:
        r = requests.get(JSON_URL, timeout=25)
        if r.status_code != 200:
            print(f"[-] Failed to fetch JSON. HTTP Status: {r.status_code}")
            return
        channels = r.json()
    except Exception as e:
        print(f"[-] Connection failed: {e}")
        return

    # Categories we want to block/filter out
    BANNED_CATEGORIES = ["shopping", "educational", "business news", "lifestyle", "devotional", "news"]

    m3u_lines = []
    # Core headers with standard EPG integrated
    m3u_lines.append('#EXTM3U x-tvg-url="https://avkb.short.gy/epg.xml.gz" url-tvg="https://avkb.short.gy/epg.xml.gz"')
    m3u_lines.append('#')
    m3u_lines.append('#  JioTV Plus — Auto-Updated Caching M3U Playlist')
    m3u_lines.append('#  Owner    : Boss Kobir')
    m3u_lines.append('#  Status   : Fully Compatible with VLC, Kodi, TiviMate, OTT Navigator')
    m3u_lines.append('#')
    m3u_lines.append('')

    filtered_count = 0
    total_count = 0

    for ch in channels:
        name = ch.get("name", "Unknown Channel")
        category = ch.get("category", "General")
        
        # Filter out banned categories
        if category.lower().strip() in BANNED_CATEGORIES:
            filtered_count += 1
            continue

        total_count += 1
        logo = ch.get("logo", "")
        tvg_id = ch.get("channel_id", "")
        mpd_url = ch.get("mpd", "")
        token = ch.get("token", "")
        referer = ch.get("referer", "https://www.jiotv.com/")
        ua = ch.get("userAgent", "@allinone_reborn")
        drm = ch.get("drm", {})

        # Parse the direct path and query parameters cleanly using urlparse
        parsed_mpd = urlparse(mpd_url)
        path_part = parsed_mpd.path
        if path_part.startswith("/jtv-plus/jtv.php"):
            path_part = path_part.replace("/jtv-plus/jtv.php", "")
            
        query_part = parsed_mpd.query
        query_str = f"?{query_part}" if query_part else ""
            
        stream_url = f"{SERVER_URL}{path_part}{query_str}"

        # Write EXTINF with metadata
        m3u_lines.append(f'#EXTINF:-1 tvg-id="{tvg_id}" tvg-logo="{logo}" group-title="{category}", {name}')

        # Write ClearKey DRM properties if available (Normalised to JWK for maximum player compatibility!)
        if drm and isinstance(drm, dict):
            jwk_keys = []
            for kid_hex, key_hex in drm.items():
                kid_b64 = hex_to_base64url(kid_hex)
                key_b64 = hex_to_base64url(key_hex)
                if kid_b64 and key_b64:
                    jwk_keys.append({"kty": "oct", "kid": kid_b64, "k": key_b64})
            
            if jwk_keys:
                jwk_json = json.dumps({"keys": jwk_keys, "type": "temporary"}, separators=(',', ':'))
                m3u_lines.append(f'#KODIPROP:inputstream.adaptive.license_type=clearkey')
                m3u_lines.append(f'#KODIPROP:inputstream.adaptive.license_key={jwk_json}')

        # Write Player compatibility headers
        m3u_lines.append(f'#EXTVLCOPT:http-user-agent={ua}')
        if token:
            m3u_lines.append(f'#EXTHTTP:{{"cookie":"{token}"}}')
            # For InputStream Adaptive
            hdrs = f"User-Agent={ua}&Referer={referer}&Origin=https://jtvxweb.pages.dev"
            m3u_lines.append(f'#KODIPROP:inputstream.adaptive.manifest_headers={hdrs}')
            m3u_lines.append(f'#KODIPROP:inputstream.adaptive.stream_headers={hdrs}')

        if ".mpd" in mpd_url:
            m3u_lines.append('#KODIPROP:inputstream.adaptive.manifest_type=mpd')

        m3u_lines.append(stream_url)
        m3u_lines.append('')

    with open(OUTPUT_M3U, "w", encoding="utf-8") as f:
        f.write("\n".join(m3u_lines))

    print(f"[+] Rebuild complete!")
    print(f"[+] Total channels processed: {total_count}")
    print(f"[+] Filtered out: {filtered_count} channels.")
    print(f"[+] Output saved to: {OUTPUT_M3U}")

if __name__ == "__main__":
    main()
