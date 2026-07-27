import os
import time
import requests
import threading
from concurrent.futures import ThreadPoolExecutor

# ==============================================================================
# Boss Kobir - JioTV Plus 24/7 Active Stream Cacher & Warmer Script
# ==============================================================================
# This script is specially optimized to run 24/7 as a Python Service on Railway
# or on your personal VPS, dedicated solely to your JioTV Plus worldwide M3U list!
# ==============================================================================

# Configuration (JioTV Plus Dedicated Playlist)
RAILWAY_PLAYLIST_URL = os.environ.get(
    "RAILWAY_PLAYLIST_URL", 
    "https://raw.githubusercontent.com/ytprobd7890-sketch/m3u/refs/heads/main/output/jtvplusww.m3u"
)
MAX_CONCURRENT_THREADS = int(os.environ.get("MAX_CONCURRENT_THREADS", "50"))
CHANNEL_WARM_TIMEOUT = int(os.environ.get("CHANNEL_WARM_TIMEOUT", "3"))

def get_channels_list():
    """Fetches the master M3U playlist from JioTV Plus and indexes all channel URLs."""
    print(f"[JioTV+ Cacher] Fetching master M3U playlist from: {RAILWAY_PLAYLIST_URL}")
    try:
        r = requests.get(RAILWAY_PLAYLIST_URL, timeout=15)
        if r.status_code != 200:
            print(f"[Error] Failed to fetch master playlist. Status: {r.status_code}")
            return []
        
        lines = r.text.split("\n")
        stream_urls = []
        for line in lines:
            line = line.strip()
            if line and line.startswith("http"):
                stream_urls.append(line)
        
        print(f"[JioTV+ Cacher] Successfully indexed {len(stream_urls)} channels for proactive 24/7 caching!")
        return stream_urls
    except Exception as e:
        print(f"[Error] Failed to read playlist: {e}")
        return []

def warm_and_cache_channel(stream_url):
    """
    Requests the sub-playlist, parses the segment URL, and requests it 
    from your Pro Cache Node to force direct disk caching of video chunks.
    """
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': 'https://jtvxweb.pages.dev/',
            'Origin': 'https://jtvxweb.pages.dev'
        }
        
        # Step 1: Request the sub-playlist (.m3u8 or .mpd) from source
        r = requests.get(stream_url, headers=headers, timeout=5)
        if r.status_code != 200:
            return
        
        # Step 2: Parse the returned manifest to find the segment URL
        lines = r.text.split("\n")
        segment_url = ""
        for line in lines:
            line = line.strip()
            if line and "segment?url=" in line:
                segment_url = line
                break
        
        # Step 3: Hit the Pro Cache Node segment URL
        # This triggers the Cache Node to download the raw segment file and save it to disk!
        if segment_url:
            requests.get(segment_url, headers=headers, timeout=CHANNEL_WARM_TIMEOUT, stream=True)
    except Exception:
        pass

def start_active_caching_loop():
    """Infinite loop that runs the active 24/7 video chunk caching process."""
    while True:
        urls = get_channels_list()
        if not urls:
            print("[JioTV+ Cacher] No channels found. Retrying in 15 seconds...")
            time.sleep(15)
            continue
        
        print(f"[JioTV+ Cacher] Launching active caching cycle for {len(urls)} channels using {MAX_CONCURRENT_THREADS} threads...")
        start_time = time.time()
        
        # Run multithreaded warming across all channels
        with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_THREADS) as executor:
            executor.map(warm_and_cache_channel, urls)
            
        elapsed = time.time() - start_time
        print(f"[JioTV+ Cacher] Completed 1 active caching cycle in {elapsed:.2f} seconds. Starting next cycle immediately...")
        time.sleep(1)

if __name__ == "__main__":
    print("==================================================================")
    print("🚀 BOSS KOBIR - 24/7 ACTIVE JIOTV PLUS CACHER SERVICE RUNNING")
    print("==================================================================")
    print(f"Target Playlist: {RAILWAY_PLAYLIST_URL}")
    print(f"Max Threads:     {MAX_CONCURRENT_THREADS}")
    print(f"Warm Timeout:    {CHANNEL_WARM_TIMEOUT}s")
    print("==================================================================")
    start_active_caching_loop()
