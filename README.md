# jstar-worldwide

Auto-refreshing IPTV playlist that takes the original **India-only** `jstar.m3u`
from `alex4528.site` and rewrites every JioTV CDN URL through the
`mini.allinonereborn.site` proxy so the channels play from **anywhere in the
world**.

- ⏱ Refreshes every **hour** via GitHub Actions (the source URLs contain
  `__hdnea__` HMAC tokens that expire after ~6h, so hourly is well within margin).
- 🌍 All ~1,260 JioTV channels usable outside India — no VPN needed.
- 🔐 Preserves the original multi-key JWK ClearKey DRM blocks exactly.
- 📄 Outputs **both** `worldwide.m3u` (for players) and `worldwide.json`
  (structured — great for building dashboards / EPGs / re-generators).
- 🎧 M3U emits headers in **three formats** so Kodi / InputStream Adaptive, VLC,
  Tivimate, OTT Navigator and IPTVnator all pick them up.

---

## Playlist URLs (once you push to GitHub)

**M3U** (for IPTV players):
```
https://raw.githubusercontent.com/<YOUR-USER>/<YOUR-REPO>/main/output/worldwide.m3u
```

**JSON** (structured data — 1,267 channels with metadata, DRM keys, headers, tokens):
```
https://raw.githubusercontent.com/<YOUR-USER>/<YOUR-REPO>/main/output/worldwide.json
```

Add the M3U URL as a "remote M3U playlist" in your IPTV player.

---

## Setup

1. **Create a new GitHub repository** (public or private — either works).
2. **Push these files** to it:
   ```
   .github/workflows/build.yml
   scripts/build_playlist.py
   requirements.txt
   output/                (folder — leave empty, the workflow fills it)
   ```
3. **Enable Actions**: Repo → Settings → Actions → General →
   **Workflow permissions** → tick **"Read and write permissions"**.
   *(Required so the workflow can commit the refreshed playlist back.)*
4. Go to the **Actions** tab → **Build Worldwide Playlist** → **Run workflow**
   to trigger the first build. After it finishes, `output/worldwide.m3u`
   will appear in your repo.

That's it — from then on it refreshes itself every 4 hours.

---

## Manual run

```bash
pip install -r requirements.txt
python scripts/build_playlist.py
# → output/worldwide.m3u
# → output/worldwide.json
# → output/worldwide.stats.json
```

Override the source with an env var:

```bash
SOURCE_URL="https://alex4528.site/playlist/jstar.m3u" \
  python scripts/build_playlist.py
```

---

## How it works

Every JioTV URL like:

```
https://jiotvmblive.cdn.jio.com/bpk-tv/Nick_Hindi_MOB/WDVLive/index.mpd?__hdnea__=...
```

is rewritten to:

```
https://mini.allinonereborn.site/jtv-plus/jtv.php/Nick_Hindi_MOB/WDVLive/index.mpd?__hdnea__=...
```

The proxy also demands the following headers, which the script bakes into
every channel entry:

| Header | Value |
| --- | --- |
| `User-Agent` | real Chrome desktop UA |
| `Referer`   | `https://jtvxweb.pages.dev/` |
| `Origin`    | `https://jtvxweb.pages.dev` |

The junk `&xxx=%7Ccookie=...` suffix that the source tacks onto every URL is
also stripped — the proxy doesn't need it.

---

## Recommended players

1. **OTT Navigator** (Android) — reads `#KODIPROP` natively.
2. **Kodi** + **InputStream Adaptive** — most robust.
3. **Tivimate Premium** (Android) — reads `#EXTHTTP`.
4. **IPTVnator** (Windows / macOS / Linux) — reads `#EXTHTTP`.

Plain VLC **won't** work — VLC doesn't decrypt MPEG-DASH ClearKey.

---

## Files

```
.
├── .github/workflows/build.yml   # scheduled + manual builder
├── scripts/build_playlist.py     # the converter
├── requirements.txt              # requests
├── output/
│   ├── worldwide.m3u             # ← the playlist (auto-generated)
│   ├── worldwide.json            # ← structured channel list (auto-generated)
│   └── worldwide.stats.json      # build stats
└── README.md
```

---

## License

MIT. This repo just re-formats a public playlist and points it at a public
proxy — no content is redistributed.
