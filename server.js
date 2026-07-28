const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const os = require('os');

// ==============================================================================
// Boss Kobir - JioTV Plus 24/7 Active Caching Proxy Server (Enterprise Edition)
// ==============================================================================
// This server is completely dedicated to JioTV Plus streaming & caching.
// It actively pulls and caches live video segments of the entire worldwide M3U playlist!
// Supports both HLS (.m3u8/.ts) and MPEG-DASH (.mpd/.dash) protocols natively.
// ==============================================================================

const PORT = process.env.PORT || 8080;
const CACHE_DIR = path.join(__dirname, 'cache_segments');
const ALLOWED_247_FILE = path.join(__dirname, 'allowed_247_channels.json');

function loadAllowed247Channels() {
    let allowed = ["Nick Bangla", "ABP Ananda", "Colors Cineplex Bollywood"]; // Defaults
    
    // Try loading from file
    if (fs.existsSync(ALLOWED_247_FILE)) {
        try {
            const fileData = fs.readFileSync(ALLOWED_247_FILE, 'utf8');
            allowed = JSON.parse(fileData);
        } catch (e) {
            // Fallback
        }
    } else {
        // Create default file
        try {
            fs.writeFileSync(ALLOWED_247_FILE, JSON.stringify(allowed, null, 2), 'utf8');
        } catch (e) {}
    }

    // Merge with environment variable if present
    if (process.env.ALLOWED_247_CHANNELS) {
        const envChannels = process.env.ALLOWED_247_CHANNELS.split(',').map(c => c.trim()).filter(Boolean);
        if (envChannels.length > 0) {
            allowed = envChannels;
        }
    }

    return allowed;
}

// Smart Cache Eviction Configuration (Prevents disk filling & memory clogging)
const MAX_CACHE_FILES = parseInt(process.env.MAX_CACHE_FILES || "300"); // Max files allowed on disk
const MAX_CACHE_AGE_MS = parseInt(process.env.MAX_CACHE_AGE_MS || "180000"); // 3 minutes max segment age

function smartAutoCleanSegments() {
    try {
        if (!fs.existsSync(CACHE_DIR)) return;

        const files = fs.readdirSync(CACHE_DIR);
        const now = Date.now();
        const fileDetails = [];

        files.forEach(file => {
            const filePath = path.join(CACHE_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                fileDetails.push({ name: file, path: filePath, mtime: stats.mtimeMs, size: stats.size });
            } catch (e) {
                // Ignore transient locked files
            }
        });

        // 1. Evict based on age (older than 3 minutes)
        let deletedByAge = 0;
        const activeFiles = [];

        fileDetails.forEach(file => {
            if (now - file.mtime > MAX_CACHE_AGE_MS) {
                try {
                    fs.unlinkSync(file.path);
                    deletedByAge++;
                } catch (e) {}
            } else {
                activeFiles.push(file);
            }
        });

        // 2. Evict based on capacity (delete oldest files first)
        let deletedByCapacity = 0;
        if (activeFiles.length > MAX_CACHE_FILES) {
            activeFiles.sort((a, b) => a.mtime - b.mtime); // Oldest first
            
            const toDeleteCount = activeFiles.length - MAX_CACHE_FILES;
            for (let i = 0; i < toDeleteCount; i++) {
                try {
                    fs.unlinkSync(activeFiles[i].path);
                    deletedByCapacity++;
                } catch (e) {}
            }
        }

        if (deletedByAge > 0 || deletedByCapacity > 0) {
            console.log(`[Smart Cleaner] Evicted ${deletedByAge} expired segments and ${deletedByCapacity} over-capacity segments. Active segments on disk: ${fs.readdirSync(CACHE_DIR).length}`);
        }
    } catch (err) {
        console.error("[Smart Cleaner Error] Eviction cycle failed:", err.message);
    }
}

// Run Smart Auto-Cleaner as a standalone high-priority timer every 10 seconds!
setInterval(smartAutoCleanSegments, 10000);

// Configuration (JioTV Plus Dedicated Playlist)
const RAILWAY_PLAYLIST_URL = process.env.RAILWAY_PLAYLIST_URL || "https://github.com/ytprobd7890-sketch/m3u/raw/refs/heads/main/output/jtvplusww.m3u";
const MAX_CONCURRENT_HARVESTERS = parseInt(process.env.MAX_CONCURRENT_HARVESTERS || "40"); 

// Telemetry Analytics
let totalRequestsServed = 0;
let totalSegmentsCached24_7 = 0;
const cachedChannelsMap = new Map(); // ch_name -> { id, name, genre, last_cached_at, timestamp }
const cachedGenresMap = {};          // genre -> count

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Clean Base64URL Encoding/Decoding
function base64UrlEncode(data) {
    return Buffer.from(data, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecode(encoded) {
    try {
        let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return Buffer.from(b64, 'base64').toString('utf8');
    } catch (e) {
        return '';
    }
}

// Helper to format uptime into human-readable format
function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d}d, ${h}h, ${m}m, ${s}s`;
}

// Default stream headers (Bypasses bot blockers)
const STREAM_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Referer': 'https://jtvxweb.pages.dev/',
    'Origin': 'https://jtvxweb.pages.dev',
    'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site'
};

// Generic HTTP/HTTPS Fetch Helper with Automatic Redirect Following (Up to 5 hops)
function fetchUrl(targetUrl, headers = {}, redirectCount = 0) {
    if (redirectCount > 5) {
        return Promise.reject(new Error("Too many redirects"));
    }
    return new Promise((resolve, reject) => {
        const parsed = url.parse(targetUrl);
        const client = parsed.protocol === 'https:' ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.path,
            method: 'GET',
            rejectUnauthorized: false,
            headers: { ...STREAM_HEADERS, ...headers }
        };
        const req = client.request(options, (res) => {
            // Check for redirect status codes (301, 302, 303, 307, 308)
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const parsedOriginal = url.parse(targetUrl);
                    redirectUrl = `${parsedOriginal.protocol}//${parsedOriginal.host}${redirectUrl.startsWith('/') ? '' : '/'}${redirectUrl}`;
                }
                resolve(fetchUrl(redirectUrl, headers, redirectCount + 1));
                return;
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ data, statusCode: res.statusCode, headers: res.headers, finalUrl: targetUrl }));
        });
        req.on('error', reject);
        req.end();
    });
}

// Active 24/7 Channel Segment Harvester Worker
async function harvestChannelSegment(channelM3u8Url) {
    try {
        const parsedUrl = url.parse(channelM3u8Url, true);
        const chId = parsedUrl.query.id || '0';

        // Step 1: Fetch the manifest from source
        const m3u8Res = await fetchUrl(channelM3u8Url);
        if (m3u8Res.statusCode !== 200) return;

        // Step 2: Parse to find the target segment URL (.ts or .dash)
        const lines = m3u8Res.data.split('\n');
        let segmentUrl = '';
        for (let line of lines) {
            line = line.trim();
            if (line && line.startsWith('http')) {
                segmentUrl = line;
                break;
            }
        }

        if (!segmentUrl) return;

        // Extract metadata if available in query params
        const parsedSeg = url.parse(segmentUrl, true);
        const chName = parsedSeg.query.ch_name || 'Unknown';
        const genre = parsedSeg.query.genre || 'General';
        const rawTargetUrl = base64UrlDecode(parsedSeg.query.url);

        if (!rawTargetUrl) return;

        const isDashSegment = rawTargetUrl.endsWith('.dash') || rawTargetUrl.includes('.dash?');
        const ext = isDashSegment ? 'dash' : 'ts';
        const urlHash = crypto.createHash('md5').update(rawTargetUrl).digest('hex');
        const cacheFilePath = path.join(CACHE_DIR, `${urlHash}.${ext}`);

        // Check if segment is already cached
        if (fs.existsSync(cacheFilePath)) {
            cachedChannelsMap.set(chName, {
                id: chId,
                name: chName,
                genre: genre,
                last_cached_at: new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" }),
                timestamp: Date.now()
            });
            return; 
        }

        // Step 3: Fetch raw segment and write directly to 1TB local SSD
        const parsedTarget = url.parse(rawTargetUrl);
        const client = parsedTarget.protocol === 'https:' ? https : http;
        
        const options = {
            hostname: parsedTarget.hostname,
            port: parsedTarget.port,
            path: parsedTarget.path,
            method: 'GET',
            headers: STREAM_HEADERS
        };

        await new Promise((resolve, reject) => {
            const req = client.request(options, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`CDN status: ${res.statusCode}`));
                    return;
                }
                const writer = fs.createWriteStream(cacheFilePath);
                res.pipe(writer);
                res.on('end', () => {
                    writer.close();
                    totalSegmentsCached24_7++;
                    cachedChannelsMap.set(chName, {
                        id: chId,
                        name: chName,
                        genre: genre,
                        last_cached_at: new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" }),
                        timestamp: Date.now()
                    });
                    if (!cachedGenresMap[genre]) cachedGenresMap[genre] = 0;
                    cachedGenresMap[genre]++;
                    resolve();
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            req.end();
        });

    } catch (e) {
        // Fail silently
    }
}

// Main 24/7 Active Harvester Loop
async function runActiveHarvesterLoop() {
    console.log("[Harvester] Querying master M3U playlist from JioTV Plus to index channels...");
    let m3uRes;
    try {
        m3uRes = await fetchUrl(RAILWAY_PLAYLIST_URL);
    } catch (err) {
        console.error("[Harvester Error] Failed to contact playlist source:", err.message);
        setTimeout(runActiveHarvesterLoop, 15000); 
        return;
    }

    if (m3uRes.statusCode !== 200) {
        console.error(`[Harvester Error] Playlist source returned status: ${m3uRes.statusCode}`);
        setTimeout(runActiveHarvesterLoop, 15000);
        return;
    }

    const lines = m3uRes.data.split('\n');
    const channelUrls = [];
    const BANNED_GENRES = ["Shopping", "Educational", "Business News", "Lifestyle", "Devotional", "News"];
    const ALLOWED_247 = loadAllowed247Channels();

    let lastGroupTitle = "";
    let lastChName = "";
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const match = line.match(/group-title="([^"]+)"/);
            if (match) {
                lastGroupTitle = match[1].trim();
            } else {
                lastGroupTitle = "";
            }
            const nameParts = line.split(',');
            lastChName = nameParts[nameParts.length - 1].trim();
        } else if (line.startsWith('http')) {
            const isBanned = BANNED_GENRES.some(genre => lastGroupTitle.toLowerCase() === genre.toLowerCase());
            if (!isBanned) {
                const isAllowed247 = ALLOWED_247.some(allowedName => lastChName.toLowerCase().includes(allowedName.toLowerCase()));
                if (isAllowed247) {
                    channelUrls.push(line);
                }
            }
            lastGroupTitle = "";
            lastChName = "";
        }
    }

    console.log(`[Harvester] Successfully indexed ${channelUrls.length} favorite channels for active 24/7 pre-caching. Starting parallel cycle...`);

    let index = 0;
    async function worker() {
        while (index < channelUrls.length) {
            const url = channelUrls[index++];
            await harvestChannelSegment(url);
        }
    }

    // Launch parallel workers
    const workers = [];
    for (let i = 0; i < Math.min(MAX_CONCURRENT_HARVESTERS, channelUrls.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    console.log(`[Harvester] Completed 1 full active 24/7 harvesting cycle. Starting next cycle in 2 seconds...`);
    
    // Auto-clean old chunk segments with smart LRU eviction
    smartAutoCleanSegments();

    // Auto-clean channels from memory list if not active for 10 minutes
    const now = Date.now();
    cachedChannelsMap.forEach((val, key) => {
        if (now - val.timestamp > 600000) {
            cachedChannelsMap.delete(key);
        }
    });

    setTimeout(runActiveHarvesterLoop, 2000);
}

// Start Background Harvester Loop immediately on server boot!
setTimeout(runActiveHarvesterLoop, 5000);


// ==============================================================================
// HTTP API & Caching Proxy Server (Dual HLS & DASH Engine)
// ==============================================================================
const server = http.createServer((req, res) => {
    totalRequestsServed++;

    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // ─── ROUTE 1: Premium Protected DASH MPD Proxy (/mpd?url=ENCODED_URL&headers=ENCODED_HEADERS) ───
    if (pathname === '/mpd' || pathname === '/index.mpd') {
        const encodedUrl = parsedUrl.query.url;
        if (!encodedUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing target MPD URL');
            return;
        }

        const targetMpdUrl = base64UrlDecode(encodedUrl);
        if (!targetMpdUrl || !targetMpdUrl.startsWith('http')) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid target MPD URL');
            return;
        }

        // Fetch the original MPD XML from the secure source
        fetchUrl(targetMpdUrl).then((mpdRes) => {
            if (mpdRes.statusCode !== 200) {
                res.writeHead(mpdRes.statusCode, { 'Content-Type': 'text/plain' });
                res.end(`Source responded with error status: ${mpdRes.statusCode}`);
                return;
            }

            let mpdData = mpdRes.data;
            serveAndRewriteMpd(mpdData, mpdRes.finalUrl || targetMpdUrl, res);
        }).catch(err => {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Failed to fetch MPD: ${err.message}`);
        });
        return;
    }

    // Helper: Parse and rewrite DASH MPD paths to route all .dash segments through Pro Cache Node!
    function serveAndRewriteMpd(xmlData, sourceMpdUrl, response) {
        if (!xmlData || !xmlData.includes('<MPD')) {
            response.writeHead(502, { 'Content-Type': 'text/plain' });
            response.end('Invalid MPD content received from source');
            return;
        }

        const proto = ((!empty(req.headers['x-forwarded-proto']) && req.headers['x-forwarded-proto'] === 'https') || req.connection.encrypted) ? 'https' : 'http';
        const hostHeader = req.headers.host || 'localhost';
        const selfBase = `${proto}://${hostHeader}`;

        // Find BaseURL of the MPD source
        const mpdBaseUrl = sourceMpdUrl.substring(0, sourceMpdUrl.lastIndexOf('/'));

        // 1. Rewrite BaseURL tags
        xmlData = xmlData.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (match, relPath) => {
            if (relPath.startsWith('http')) return match;
            const absBaseUrl = `${mpdBaseUrl}/${relPath}`;
            return `<BaseURL>${selfBase}/dash_segment?url=${base64UrlEncode(absBaseUrl)}&amp;</BaseURL>`;
        });

        // 2. Rewrite initialization and media template paths
        const rewriteTemplateAttribute = (match, attributeName, relPath) => {
            if (relPath.startsWith('http')) return match;
            const absPath = relPath.startsWith('/') ? `${url.parse(sourceMpdUrl).protocol}//${url.parse(sourceMpdUrl).host}${relPath}` : `${mpdBaseUrl}/${relPath}`;
            
            const dollarIndex = absPath.indexOf('$');
            let proxiedUrl;
            if (dollarIndex === -1) {
                proxiedUrl = `${selfBase}/dash_segment?url=${base64UrlEncode(absPath)}&amp;`;
            } else {
                const basePath = absPath.substring(0, dollarIndex);
                const templatePart = absPath.substring(dollarIndex);
                proxiedUrl = `${selfBase}/dash_segment?base=${base64UrlEncode(basePath)}&amp;temp=${templatePart}&amp;`;
            }
            return `${attributeName}="${proxiedUrl}"`;
        };

        xmlData = xmlData.replace(/(initialization|media)="([^"]+)"/g, rewriteTemplateAttribute);

        response.writeHead(200, {
            'Content-Type': 'application/dash+xml',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*'
        });
        response.end(xmlData);
    }

    // ─── ROUTE 2: DASH Segment Caching Proxy (/dash_segment?url=ENCODED_URL) ───
    if (pathname === '/dash_segment') {
        let targetSegmentUrl = '';
        if (parsedUrl.query.base && parsedUrl.query.temp) {
            targetSegmentUrl = base64UrlDecode(parsedUrl.query.base) + parsedUrl.query.temp;
        } else {
            const encodedUrl = parsedUrl.query.url;
            if (encodedUrl) {
                targetSegmentUrl = base64UrlDecode(encodedUrl);
            }
        }

        if (!targetSegmentUrl || !targetSegmentUrl.startsWith('http')) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing or invalid target segment URL');
            return;
        }

        const urlHash = crypto.createHash('md5').update(targetSegmentUrl).digest('hex');
        const cacheFilePath = path.join(CACHE_DIR, `${urlHash}.dash`);

        // Check if this segment is already cached on disk (Cache HIT)
        if (fs.existsSync(cacheFilePath)) {
            const stat = fs.statSync(cacheFilePath);
            res.writeHead(200, {
                'Content-Type': 'video/mp4', 
                'Content-Length': stat.size,
                'X-Cache-Status': 'HIT',
                'Cache-Control': 'no-cache'
            });
            fs.createReadStream(cacheFilePath).pipe(res);
            return;
        }

        // Cache MISS: Fetch from CDN with custom headers and write to disk
        const parsedTarget = url.parse(targetSegmentUrl);
        const client = parsedTarget.protocol === 'https:' ? https : http;
        
        const options = {
            hostname: parsedTarget.hostname,
            port: parsedTarget.port,
            path: parsedTarget.path,
            method: 'GET',
            headers: STREAM_HEADERS
        };

        const cReq = client.request(options, (cRes) => {
            if (cRes.statusCode !== 200) {
                res.writeHead(cRes.statusCode, { 'Content-Type': 'text/plain' });
                res.end(`Source CDN responded with status: ${cRes.statusCode}`);
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'X-Cache-Status': 'MISS',
                'Cache-Control': 'no-cache'
            });

            const cacheWriter = fs.createWriteStream(cacheFilePath);
            cRes.pipe(res);
            cRes.pipe(cacheWriter);

            cRes.on('end', () => cacheWriter.close());
            cRes.on('error', () => {
                cacheWriter.close();
                fs.unlink(cacheFilePath, () => {});
            });
        });

        cReq.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Failed to fetch segment: ${err.message}`);
        });

        cReq.end();
        return;
    }

    // ─── ROUTE 3: Serve HLS segments directly from the 24/7 Active cache (Ultra fast!) ───
    if (pathname === '/segment') {
        const encryptedUrl = parsedUrl.query.url;
        if (!encryptedUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing encrypted segment URL');
            return;
        }

        const targetUrl = base64UrlDecode(encryptedUrl);
        if (!targetUrl || !targetUrl.startsWith('http')) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid segment URL');
            return;
        }

        const urlHash = crypto.createHash('md5').update(targetUrl).digest('hex');
        const cacheFilePath = path.join(CACHE_DIR, `${urlHash}.ts`);

        // Cache HIT: Stream segment directly from 1TB+ SSD
        if (fs.existsSync(cacheFilePath)) {
            const stat = fs.statSync(cacheFilePath);
            res.writeHead(200, {
                'Content-Type': 'video/mp2t',
                'Content-Length': stat.size,
                'X-Cache-Status': 'HIT',
                'Cache-Control': 'no-cache'
            });
            fs.createReadStream(cacheFilePath).pipe(res);
            return;
        }

        // Cache MISS (Fallback)
        const parsedTarget = url.parse(targetUrl);
        const client = parsedTarget.protocol === 'https:' ? https : http;
        
        const options = {
            hostname: parsedTarget.hostname,
            port: parsedTarget.port,
            path: parsedTarget.path,
            method: 'GET',
            headers: STREAM_HEADERS
        };

        const cReq = client.request(options, (cRes) => {
            if (cRes.statusCode !== 200) {
                res.writeHead(cRes.statusCode, { 'Content-Type': 'text/plain' });
                res.end(`Portal CDN responded with status: ${cRes.statusCode}`);
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'video/mp2t',
                'X-Cache-Status': 'MISS_FALLBACK',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no'
            });

            const cacheWriter = fs.createWriteStream(cacheFilePath);
            cRes.pipe(res);
            cRes.pipe(cacheWriter);

            cRes.on('end', () => cacheWriter.close());
            cRes.on('error', () => {
                cacheWriter.close();
                fs.unlink(cacheFilePath, () => {});
            });
        });

        cReq.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Failed to fetch segment: ${err.message}`);
        });

        cReq.end();
        return;
    }

    // ─── ROUTE 4: Dynamic M3U Playlist of ONLY currently active cached channels! ───
    if (pathname === '/playlist.m3u' || pathname === '/playlist') {
        const proto = ((!empty(req.headers['x-forwarded-proto']) && req.headers['x-forwarded-proto'] === 'https') || req.connection.encrypted) ? 'https' : 'http';
        const hostHeader = req.headers.host || 'localhost';
        const selfBase = `${proto}://${hostHeader}`;

        let m3uLines = [];
        m3uLines.push('#EXTM3U x-tvg-url="https://avkb.short.gy/epg.xml.gz" url-tvg="https://avkb.short.gy/epg.xml.gz"');
        m3uLines.push('#');
        m3uLines.push('#  JioTV Plus — 24/7 Cached Channels Playlist');
        m3uLines.push('#  Owner    : Boss Kobir');
        m3uLines.push(`#  Uptime   : ${formatUptime(process.uptime())}`);
        m3uLines.push(`#  Channels : ${cachedChannelsMap.size}`);
        m3uLines.push('#');
        m3uLines.push('');

        cachedChannelsMap.forEach((val) => {
            const isDash = val.id.includes('index.mpd') || val.id.includes('mpd');
            const ext = isDash ? 'mpd' : 'm3u8';
            const streamUrl = `${selfBase}/stream/ch_${val.id}.${ext}`;
            m3uLines.push(`#EXTINF:-1 tvg-id="${val.id}" tvg-name="${val.name}" group-title="${val.genre}",${val.name}`);
            m3uLines.push(streamUrl);
        });

        res.writeHead(200, {
            'Content-Type': 'application/x-mpegurl; charset=utf-8',
            'Content-Disposition': 'inline; filename="JioTV_Plus_Cached_KobirTV.m3u"',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(m3uLines.join('\n'));
        return;
    }

    // Helper for empty check
    function empty(val) {
        return !val;
    }

    // ─── ROUTE 5: Serve the active segment/manifest files (/stream/ch_720.m3u8) ───
    if (pathname.startsWith('/stream/')) {
        const fileName = pathname.replace('/stream/', '');
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Access Forbidden');
            return;
        }

        const filePath = path.join(CACHE_DIR, fileName);

        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File Not Found');
            return;
        }

        const ext = path.extname(fileName);
        let contentType = 'video/mp2t';
        if (ext === '.m3u8') contentType = 'application/vnd.apple.mpegurl';
        else if (ext === '.mpd') contentType = 'application/dash+xml';
        else if (ext === '.dash') contentType = 'video/mp4';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
        });

        fs.createReadStream(filePath).pipe(res);
        return;
    }

    // ─── ROUTE 7: Manage Allowed 24/7 Pre-Cached Favorite Channels ───
    if (pathname === '/fav' || pathname === '/fav/add' || pathname === '/fav/remove') {
        const allowed = loadAllowed247Channels();
        
        if (pathname === '/fav/add') {
            const addName = parsedUrl.query.name;
            if (addName) {
                const trimmedName = addName.trim();
                if (!allowed.some(c => c.toLowerCase() === trimmedName.toLowerCase())) {
                    allowed.push(trimmedName);
                    try {
                        fs.writeFileSync(ALLOWED_247_FILE, JSON.stringify(allowed, null, 2), 'utf8');
                    } catch (e) {}
                }
            }
        } else if (pathname === '/fav/remove') {
            const removeName = parsedUrl.query.name;
            if (removeName) {
                const trimmedName = removeName.trim();
                const filtered = allowed.filter(c => c.toLowerCase() !== trimmedName.toLowerCase());
                try {
                    fs.writeFileSync(ALLOWED_247_FILE, JSON.stringify(filtered, null, 2), 'utf8');
                } catch (e) {}
            }
        }

        // Return updated list
        const currentList = fs.existsSync(ALLOWED_247_FILE) ? JSON.parse(fs.readFileSync(ALLOWED_247_FILE, 'utf8')) : allowed;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: "success",
            allowed_247_channels_count: currentList.length,
            allowed_247_channels_list: currentList,
            instructions: {
                add_favorite: "/fav/add?name=CHANNEL_NAME",
                remove_favorite: "/fav/remove?name=CHANNEL_NAME"
            }
        }, null, 2));
        return;
    }

    // ─── ROUTE 6: Real-time 24/7 Telemetry Dashboard ───
    if (pathname === '/' || pathname === '/info') {
        let cachedFilesCount = 0;
        try {
            cachedFilesCount = fs.readdirSync(CACHE_DIR).length;
        } catch (e) {
            cachedFilesCount = 0;
        }

        const mem = process.memoryUsage();
        const uptimeSecs = process.uptime();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: "active",
            service_name: "Boss Kobir's Pro 24/7 Active JioTV Plus Cache Node",
            version: "4.5.0-JioTVPlusEdition",
            owner: "Boss Kobir",
            caching_mode: "AUTOMATED_24_7_ACTIVE_PULL (No-VPS Required)",
            allowed_247_channels_count: loadAllowed247Channels().length,
            allowed_247_channels_list: loadAllowed247Channels(),
            supported_protocols: ["HLS (.m3u8/.ts)", "MPEG-DASH (.mpd/.dash)"],
            
            // Telemetry Analytics
            total_unique_channels_monitored: cachedChannelsMap.size,
            total_active_segments_on_disk: cachedFilesCount,
            total_segments_actively_cached_24_7: totalSegmentsCached24_7,
            
            // Memory & System specs
            node_version: process.version,
            platform: process.platform,
            architecture: process.arch,
            cpu_cores: os.cpus().length,
            process_memory_rss: Math.round(mem.rss / 1024 / 1024) + ' MB',
            system_total_memory: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
            system_free_memory: (os.freemem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
            
            // Location and time settings
            timezone: "Asia/Dhaka",
            system_time_now: new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" }),
            uptime_formatted: formatUptime(uptimeSecs),
            
            // Channels and Genres Details
            cached_channels_last_active_list: Object.fromEntries(cachedChannelsMap),
            cached_segments_served_by_genre: cachedGenresMap
        }, null, 2));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`🚀 Boss Kobir's Pro 24/7 Active Dual-Protocol JioTV Plus Cache Node listening on Port ${PORT}`);
});
