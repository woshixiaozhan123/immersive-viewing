/**
 * Realtime Beauty · Video Cache Network Hook (MAIN world, document_start, spec v2 · P2)
 *
 * Capabilities:
 * - Hooks window.fetch, XMLHttpRequest (open / setRequestHeader / send / abort), and media src audit
 * - Strictly bypasses local cache server (127.0.0.1:8765), blob:, data:, and non-target hosts
 * - Reads authoritative track metadata from window.__playinfo__ AND live /x/player/(wbi/)?playurl responses
 *   so Bilibili video & audio tracks map deterministically to bili:<cid>:1:<qn> and bili:<cid>:2:<qn>
 * - Active Master-Track Confirmation for cache-miss enqueuing (eliminates ABR one-shot probe clutter)
 * - Synchronous localHas() via in-memory RANGE_SNAP + sessionStorage("rb_ranges") + HIT_MEM
 * - P2 Local Hit Redirection with 100% transparent CDN fallback on BOTH window.fetch and XMLHttpRequest
 *   (with 5s circuit-breaker when local cache-server is offline so fallback adds zero stall)
 * - Silently disables itself if EME DRM (navigator.requestMediaKeySystemAccess) is invoked
 */
(() => {
  if (window.__RB_CACHE_HOOK__) return;
  window.__RB_CACHE_HOOK__ = true;

  const LOCAL_ORIGIN = "http://127.0.0.1:8765";
  const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const SESSION_KEY = "rb_ranges";
  const SERVER_DOWN_COOLDOWN_MS = 5000;

  let drmDetected = false;
  let redirectEnabled = true;
  let localServerDownUntil = 0;

  // Live observability counters
  const STATS = {
    hits: 0,
    xhrHits: 0,
    fetchHits: 0,
    hitBytes: 0,
    misses: 0,
    fallbacks: 0,
  };

  // Detect EME DRM invocation and silently disable caching on DRM pages (spec section 9)
  try {
    if (navigator && typeof navigator.requestMediaKeySystemAccess === "function") {
      const origReqEme = navigator.requestMediaKeySystemAccess.bind(navigator);
      navigator.requestMediaKeySystemAccess = function (...args) {
        drmDetected = true;
        return origReqEme(...args);
      };
    }
  } catch (_) {}

  // Two-level synchronous range coverage table:
  // RANGE_SNAP: { [videoKey]: { merged: [[s, e], ...], totalBytes: number|null, complete: bool, kind: string } }
  let RANGE_SNAP = {};
  const HIT_MEM = new Set(); // `${videoKey}|${start}|${end}`

  function normalizeRangeSnap(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) {
        out[k] = { merged: v, totalBytes: null, complete: false, kind: "video" };
      } else if (v && typeof v === "object" && Array.isArray(v.merged)) {
        out[k] = {
          merged: v.merged,
          totalBytes: typeof v.totalBytes === "number" && v.totalBytes > 0 ? v.totalBytes : null,
          complete: Boolean(v.complete),
          kind: v.kind || "video",
        };
      }
    }
    return out;
  }

  function loadSessionRangesSync() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        RANGE_SNAP = normalizeRangeSnap(JSON.parse(raw));
      }
    } catch (_) {}
  }

  loadSessionRangesSync();

  // Receive periodic & on-demand range table pushes from ISOLATED-world content/cache-relay.js
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.__rbCache !== "ranges-sync") return;

    if (typeof data.redirectEnabled === "boolean") {
      redirectEnabled = data.redirectEnabled;
    }
    if (data.offline) {
      localServerDownUntil = Date.now() + SERVER_DOWN_COOLDOWN_MS;
      return;
    }
    if (data.ranges && typeof data.ranges === "object") {
      RANGE_SNAP = normalizeRangeSnap(data.ranges);
      HIT_MEM.clear();
      localServerDownUntil = 0;
    }
  });

  function requestRangesSync() {
    try {
      window.postMessage({ __rbCache: "request-ranges" }, "*");
    } catch (_) {}
  }

  function markLocalServerDown() {
    localServerDownUntil = Date.now() + SERVER_DOWN_COOLDOWN_MS;
  }

  function invalidateLocalRange(videoKey, rangeTuple) {
    if (!videoKey) return;
    if (rangeTuple) {
      HIT_MEM.delete(`${videoKey}|${rangeTuple[0]}|${rangeTuple[1]}`);
    }
    delete RANGE_SNAP[videoKey];
    for (const key of Array.from(HIT_MEM)) {
      if (key.startsWith(`${videoKey}|`)) HIT_MEM.delete(key);
    }
    requestRangesSync();
  }

  // Authoritative track metadata harvested from __playinfo__ and /x/player/(wbi/)?playurl
  const TRACK_META_BY_PATH = new Map();
  const TRACK_META_BY_CQ = new Map();
  let lastPlayinfoMetaCount = 0;

  // Active track gate to drop ABR one-shot probe tracks (e.g. 100023 probed once for 0-1682 then abandoned)
  const ACTIVE_TRACKS = new Set();
  const PENDING_INIT = new Map();
  const SEEN_CDN_OBS = new Set();

  const BILI_M4S_RE = /\/upgcxcode\/\d+\/\d+\/(\d+)\/(\d+)(?:_[a-z0-9]+)?-(\d+)-(\d+)\.m4s$/i;
  const BILI_HOST_RE = /(^|\.)bilivideo\.(com|cn)$/i;
  const YT_HOST_RE = /(^|\.)googlevideo\.com$/i;
  const PLAYURL_API_RE = /\/x\/player\/(wbi\/)?playurl\b/i;

  function registerDashTracks(dash) {
    if (!dash || typeof dash !== "object") return;
    const duration = typeof dash.duration === "number" ? dash.duration : null;

    const addList = (list, kind) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const urls = [];
        if (typeof item.baseUrl === "string") urls.push(item.baseUrl);
        if (typeof item.base_url === "string") urls.push(item.base_url);
        if (Array.isArray(item.backupUrl)) urls.push(...item.backupUrl);
        if (Array.isArray(item.backup_url)) urls.push(...item.backup_url);

        const meta = {
          kind,
          mimeType: item.mimeType || item.mime_type || (kind === "audio" ? "audio/mp4" : "video/mp4"),
          bandwidth: Number(item.bandwidth) || 0,
          codecid: Number(item.codecid) || 0,
          qn: Number(item.id) || 0,
          duration,
        };

        for (const raw of urls) {
          try {
            const u = new URL(raw, window.location.href);
            TRACK_META_BY_PATH.set(u.pathname, meta);
            const m = u.pathname.match(BILI_M4S_RE);
            if (m) {
              TRACK_META_BY_CQ.set(`${m[2]}:${m[4]}`, meta);
            }
          } catch (_) {}
        }
      }
    };

    addList(dash.video, "video");
    addList(dash.audio, "audio");
    if (dash.dolby && Array.isArray(dash.dolby.audio)) addList(dash.dolby.audio, "audio");
    if (dash.flac && dash.flac.audio) {
      addList(Array.isArray(dash.flac.audio) ? dash.flac.audio : [dash.flac.audio], "audio");
    }
  }

  // Track whether this page has already completed its initial playurl alignment
  let initialPlayurlAligned = false;

  function calcMergedBytes(merged) {
    if (!Array.isArray(merged)) return 0;
    let sum = 0;
    for (let i = 0; i < merged.length; i++) {
      const seg = merged[i];
      if (Array.isArray(seg) && seg.length >= 2 && seg[1] >= seg[0]) {
        sum += seg[1] - seg[0] + 1;
      }
    }
    return sum;
  }

  function extractBiliItemKey(item, kind) {
    if (!item || typeof item !== "object") return null;
    const raw = item.baseUrl || item.base_url || (Array.isArray(item.backupUrl) && item.backupUrl[0]) || "";
    if (!raw) return null;
    try {
      const u = new URL(raw, window.location.href);
      const m = u.pathname.match(BILI_M4S_RE);
      if (!m) return null;
      const cid = m[2];
      const quality = m[4];
      const normType = kind === "audio" ? "2" : "1";
      return `bili:${cid}:${normType}:${quality}`;
    } catch (_) {
      return null;
    }
  }

  function isSubstantiallyCached(videoKey) {
    const entry = RANGE_SNAP[videoKey];
    if (!entry || !entry.totalBytes || entry.totalBytes <= 0) return false;
    // Must cover initial moov/sidx header and have meaningful media bytes cached (>= 16KB)
    return isCovered(entry.merged, 0, 1024) && calcMergedBytes(entry.merged) >= 16384;
  }

  /**
   * Align auto-quality (qn=0 / initial) playurl / __playinfo__ streams to already-cached local tracks.
   * - Preserves `accept_quality` / `support_formats` so the quality menu remains intact;
   * - When the user manually selects a different quality (`qn` != 0), returns untouched streams;
   * - On auto-start (`qn=0` or inline __playinfo__), converges `dash.video`/`dash.audio` to the cached track
   *   so repeat opens emit 0 unnecessary ABR probe CDN requests and offline playback starts instantaneously.
   */
  function preferCachedTracksInPlayData(data, requestUrl) {
    if (!data || typeof data !== "object" || !data.dash) return false;
    if (drmDetected || !redirectEnabled || Date.now() < localServerDownUntil) return false;

    // Respect explicit user manual quality selection (qn != 0)
    if (requestUrl) {
      try {
        const qn = new URL(requestUrl, window.location.href).searchParams.get("qn");
        if (qn && qn !== "0") return false;
      } catch (_) {}
    }

    const dash = data.dash;
    let modified = false;

    if (Array.isArray(dash.video) && dash.video.length > 0) {
      const cachedVideos = [];
      for (const v of dash.video) {
        const key = extractBiliItemKey(v, "video");
        if (key && isSubstantiallyCached(key)) {
          cachedVideos.push({ item: v, key, bytes: calcMergedBytes(RANGE_SNAP[key].merged) });
        }
      }

      if (cachedVideos.length > 0) {
        cachedVideos.sort((a, b) => b.bytes - a.bytes);
        const best = cachedVideos[0].item;
        if (typeof best.id === "number") {
          data.quality = best.id;
        }
        dash.video = cachedVideos.map((c) => c.item);
        modified = true;
        initialPlayurlAligned = true;
      }
    }

    if (Array.isArray(dash.audio) && dash.audio.length > 0) {
      const cachedAudios = [];
      for (const a of dash.audio) {
        const key = extractBiliItemKey(a, "audio");
        if (key && isSubstantiallyCached(key)) {
          cachedAudios.push({ item: a, key, bytes: calcMergedBytes(RANGE_SNAP[key].merged) });
        }
      }
      if (cachedAudios.length > 0) {
        cachedAudios.sort((a, b) => b.bytes - a.bytes);
        dash.audio = cachedAudios.map((c) => c.item);
        modified = true;
      }
    }

    return modified;
  }

  // Intercept inline window.__playinfo__ assignment (present on logged-in Bilibili pages)
  try {
    let _playinfoVal = window.__playinfo__;
    if (_playinfoVal && _playinfoVal.data && _playinfoVal.data.dash) {
      registerDashTracks(_playinfoVal.data.dash);
      preferCachedTracksInPlayData(_playinfoVal.data);
    }
    const existingDesc = Object.getOwnPropertyDescriptor(window, "__playinfo__");
    if (!existingDesc || existingDesc.configurable) {
      Object.defineProperty(window, "__playinfo__", {
        configurable: true,
        enumerable: true,
        get() {
          return _playinfoVal;
        },
        set(val) {
          try {
            if (val && val.data && val.data.dash) {
              registerDashTracks(val.data.dash);
              preferCachedTracksInPlayData(val.data);
            }
          } catch (_) {}
          _playinfoVal = val;
        },
      });
    }
  } catch (_) {}

  function tryHarvestWindowPlayinfo() {
    try {
      const pi = window.__playinfo__;
      const dash = pi && pi.data && pi.data.dash;
      if (dash && TRACK_META_BY_PATH.size === lastPlayinfoMetaCount) {
        registerDashTracks(dash);
        lastPlayinfoMetaCount = TRACK_META_BY_PATH.size;
      }
    } catch (_) {}
  }

  function inferBiliTrackMeta(pathname, cid, urlType, quality) {
    tryHarvestWindowPlayinfo();
    const byPath = TRACK_META_BY_PATH.get(pathname);
    if (byPath) return byPath;
    const byCq = TRACK_META_BY_CQ.get(`${cid}:${quality}`);
    if (byCq) return byCq;

    // Deterministic fallback when playurl metadata hasn't arrived or offline:
    // Bilibili DASH audio IDs are strictly in 30200..30299 (30216/30232/30280/30250/30251) or explicit type=2.
    const qNum = Number(quality);
    const isAudio = urlType === "2" || (Number.isFinite(qNum) && qNum >= 30200 && qNum <= 30299);
    return {
      kind: isAudio ? "audio" : "video",
      mimeType: isAudio ? "audio/mp4" : "video/mp4",
      bandwidth: null,
      codecid: null,
      qn: null,
      duration: null,
    };
  }

  function parseSafeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    if (rawUrl.startsWith(LOCAL_ORIGIN)) return null;
    if (rawUrl.startsWith("blob:") || rawUrl.startsWith("data:") || rawUrl.startsWith("chrome-extension:")) {
      return null;
    }
    try {
      const u = new URL(rawUrl, window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (LOCAL_HOSTS.has(u.hostname)) return null;
      return u;
    } catch (_) {
      return null;
    }
  }

  function parseRangeHeader(headerVal) {
    if (!headerVal || typeof headerVal !== "string") return null;
    const m = headerVal.match(/bytes\s*=\s*(\d*)\s*-\s*(\d*)/i);
    if (!m) return null;
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : null;
    if (!Number.isFinite(start) || start < 0) return null;
    if (end !== null && (!Number.isFinite(end) || end < start)) return null;
    return [start, end];
  }

  function extractRangeFromFetch(input, init) {
    try {
      if (init && init.headers) {
        const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
        const r = h.get("range");
        if (r) return parseRangeHeader(r);
      }
      if (typeof Request !== "undefined" && input instanceof Request && input.headers) {
        const r = input.headers.get("range");
        if (r) return parseRangeHeader(r);
      }
    } catch (_) {}
    return null;
  }

  function parseRange(parsedUrl, headerRange) {
    if (headerRange) return headerRange;
    const qRange = parsedUrl.searchParams.get("range");
    if (qRange) {
      const [s, e] = qRange.split("-");
      const start = s ? parseInt(s, 10) : 0;
      const end = e ? parseInt(e, 10) : null;
      if (Number.isFinite(start) && start >= 0) {
        return [start, end !== null && Number.isFinite(end) ? end : null];
      }
    }
    return null;
  }

  function matchCdn(parsedUrl) {
    if (!parsedUrl) return null;

    if (BILI_HOST_RE.test(parsedUrl.hostname)) {
      const m = parsedUrl.pathname.match(BILI_M4S_RE);
      if (m) {
        const cid = m[2];
        const urlType = m[3];
        const quality = m[4];
        const meta = inferBiliTrackMeta(parsedUrl.pathname, cid, urlType, quality);
        // Normalize key track type: 1=video, 2=audio (deterministic online & offline)
        const normType = meta.kind === "audio" ? "2" : "1";
        return {
          videoKey: `bili:${cid}:${normType}:${quality}`,
          kind: meta.kind,
          contentType: meta.mimeType,
          bandwidth: meta.bandwidth,
          codecid: meta.codecid,
          duration: meta.duration,
          matchedRule: "bili_upgcxcode",
          url: parsedUrl.href,
        };
      }
    }

    if (YT_HOST_RE.test(parsedUrl.hostname) && /^\/videoplayback/i.test(parsedUrl.pathname)) {
      const id = parsedUrl.searchParams.get("id");
      const itag = parsedUrl.searchParams.get("itag");
      if (id && itag) {
        const mime = parsedUrl.searchParams.get("mime") || "";
        const isAudio = mime.startsWith("audio/");
        return {
          videoKey: `yt:${id}:${itag}`,
          kind: isAudio ? "audio" : "video",
          contentType: mime || (isAudio ? "audio/mp4" : "video/mp4"),
          bandwidth: null,
          codecid: null,
          duration: null,
          matchedRule: "yt_videoplayback",
          url: parsedUrl.href,
        };
      }
    }

    return null;
  }

  // Skip tiny hover-preview players on Bilibili feed/search pages (spec section 9)
  function isMainPlaybackContext() {
    const p = window.location.pathname || "";
    if (/^\/(video|bangumi\/play|list|festival)\b/i.test(p)) return true;
    try {
      const vids = document.querySelectorAll("video");
      for (const v of vids) {
        if (v.offsetWidth > 300) return true;
      }
      return vids.length === 0;
    } catch (_) {
      return true;
    }
  }

  // Spec 6.1 interval coverage algorithm (identical to backend storage.is_covered)
  function isCovered(merged, start, end) {
    if (!Array.isArray(merged) || start < 0 || end === null || end < start) return false;
    let pos = start;
    for (let i = 0; i < merged.length; i++) {
      const seg = merged[i];
      if (!Array.isArray(seg) || seg.length < 2) continue;
      if (seg[0] > pos) return false;
      if (seg[1] >= end) return true;
      if (seg[1] + 1 > pos) pos = seg[1] + 1;
    }
    return false;
  }

  // Synchronous local hit check (never awaits across processes; < 0.05ms per request)
  function localHas(hit, rangeTuple) {
    if (drmDetected || !redirectEnabled) return false;
    if (Date.now() < localServerDownUntil) return false;
    if (!hit || !hit.videoKey) return false;

    const entry = RANGE_SNAP[hit.videoKey];
    if (!entry || !Array.isArray(entry.merged) || entry.merged.length === 0) return false;
    // CRITICAL: require authoritative totalBytes so Content-Range denominator is never truncated
    if (!entry.totalBytes || entry.totalBytes <= 0) return false;

    if (!rangeTuple) {
      return Boolean(entry.complete && isCovered(entry.merged, 0, entry.totalBytes - 1));
    }

    const start = rangeTuple[0];
    const end = rangeTuple[1] === null ? entry.totalBytes - 1 : Math.min(rangeTuple[1], entry.totalBytes - 1);
    if (start < 0 || start > end) return false;

    const memKey = `${hit.videoKey}|${start}|${end}`;
    if (HIT_MEM.has(memKey)) return true;

    if (isCovered(entry.merged, start, end)) {
      if (HIT_MEM.size > 4096) HIT_MEM.clear();
      HIT_MEM.add(memKey);
      return true;
    }
    return false;
  }

  function buildLocalUrl(videoKey) {
    return `${LOCAL_ORIGIN}/cache/${encodeURIComponent(videoKey)}`;
  }

  function buildLocalRangeHeaders(rangeTuple) {
    const headers = {};
    if (rangeTuple) {
      headers.Range = `bytes=${rangeTuple[0]}-${rangeTuple[1] !== null ? rangeTuple[1] : ""}`;
    }
    return headers;
  }

  function postCdnObservation(parsedUrl, rangeTuple, transport, reason) {
    if (drmDetected || !parsedUrl) return;
    if (!BILI_HOST_RE.test(parsedUrl.hostname)) return;
    const sig = `${transport}|${reason}|${parsedUrl.hostname}${parsedUrl.pathname}`;
    if (SEEN_CDN_OBS.has(sig)) return;
    SEEN_CDN_OBS.add(sig);
    const rangeStr = rangeTuple ? `bytes=${rangeTuple[0]}-${rangeTuple[1] ?? ""}` : null;
    try {
      window.postMessage(
        {
          __rbCache: "cdn-log",
          url: parsedUrl.href,
          range: rangeStr,
          transport,
          reason,
        },
        "*"
      );
    } catch (_) {}
  }

  function emitEnqueue(payload) {
    STATS.misses++;
    try {
      console.log(
        `[rb-cache][enqueue] via=${payload.transport} kind=${payload.kind} key=${payload.videoKey} range=${payload.rangeStart}-${payload.rangeEnd ?? ""}`,
        payload.url
      );
      window.postMessage({ __rbCache: "miss", ...payload }, "*");
    } catch (_) {}
  }

  function enqueueMiss(hit, rangeTuple, transport) {
    if (drmDetected || !isMainPlaybackContext()) return;

    const rangeStart = rangeTuple ? rangeTuple[0] : 0;
    const rangeEnd = rangeTuple ? rangeTuple[1] : null;
    const payload = {
      url: hit.url,
      videoKey: hit.videoKey,
      kind: hit.kind,
      rangeStart,
      rangeEnd,
      contentType: hit.contentType,
      bandwidth: hit.bandwidth,
      codecid: hit.codecid,
      duration: hit.duration,
      transport,
      matchedRule: hit.matchedRule,
    };

    // Active Master-Track Confirmation:
    // Hold tiny initial probe/init ranges (0..<=8192) until the player actually pulls media data on this track.
    // Automatically discards ABR parallel probe tracks without ever dropping the real playing track.
    const isTinyInitProbe = rangeStart === 0 && rangeEnd !== null && rangeEnd <= 8192;
    if (!ACTIVE_TRACKS.has(hit.videoKey)) {
      if (isTinyInitProbe) {
        const list = PENDING_INIT.get(hit.videoKey) || [];
        if (list.length < 4) {
          list.push(payload);
          PENDING_INIT.set(hit.videoKey, list);
        }
        return;
      }
      ACTIVE_TRACKS.add(hit.videoKey);
      const buffered = PENDING_INIT.get(hit.videoKey);
      PENDING_INIT.delete(hit.videoKey);
      if (buffered && buffered.length) {
        for (const initPayload of buffered) {
          emitEnqueue(initPayload);
        }
      }
    }

    emitEnqueue(payload);
  }

  // =========================================================================
  // 1) Wrap window.fetch (local hit redirect + transparent CDN fallback + playurl sniff)
  // =========================================================================
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const selfThis = this;
      const origArgs = arguments;

      let rawUrl = "";
      let parsed = null;
      let rangeTuple = null;
      let hit = null;

      try {
        rawUrl = typeof input === "string" ? input : input && typeof input.url === "string" ? input.url : "";
        // First line defense against recursion
        if (rawUrl.startsWith(LOCAL_ORIGIN)) {
          return origFetch.apply(selfThis, origArgs);
        }

        if (!drmDetected && rawUrl) {
          parsed = parseSafeUrl(rawUrl);
          if (parsed) {
            rangeTuple = parseRange(parsed, extractRangeFromFetch(input, init));
            hit = matchCdn(parsed);
            if (!hit && BILI_HOST_RE.test(parsed.hostname)) {
              postCdnObservation(parsed, rangeTuple, "fetch", "bilivideo_non_m4s");
            }
          }
        }
      } catch (_) {}

      // Local cache HIT path for fetch
      if (hit && isMainPlaybackContext() && localHas(hit, rangeTuple)) {
        const method =
          (init && init.method) ||
          (typeof Request !== "undefined" && input instanceof Request && input.method) ||
          "GET";
        const upperMethod = String(method).toUpperCase();
        if (upperMethod === "GET" || upperMethod === "HEAD") {
          const localUrl = buildLocalUrl(hit.videoKey);
          const signal =
            (init && init.signal) ||
            (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);

          return origFetch
            .call(window, localUrl, {
              method: upperMethod,
              headers: buildLocalRangeHeaders(rangeTuple),
              mode: "cors",
              credentials: "omit",
              cache: "no-store",
              signal,
            })
            .then(
              (res) => {
                if (res.status === 200 || res.status === 206) {
                  STATS.hits++;
                  STATS.fetchHits++;
                  const cl = parseInt(res.headers.get("content-length") || "0", 10);
                  if (Number.isFinite(cl) && cl > 0) STATS.hitBytes += cl;
                  console.log(
                    `[rb-cache][HIT fetch ${res.status}] ${hit.videoKey} range=${rangeTuple ? `${rangeTuple[0]}-${rangeTuple[1] ?? ""}` : "full"}`
                  );
                  return res;
                }
                // 416 / 404 / 5xx -> invalidate stale range & fall back transparently to CDN
                invalidateLocalRange(hit.videoKey, rangeTuple);
                STATS.fallbacks++;
                enqueueMiss(hit, rangeTuple, "fetch");
                return origFetch.apply(selfThis, origArgs);
              },
              (err) => {
                if (err && err.name === "AbortError") throw err;
                markLocalServerDown();
                STATS.fallbacks++;
                enqueueMiss(hit, rangeTuple, "fetch");
                return origFetch.apply(selfThis, origArgs);
              }
            );
        }
      }

      // Miss path: forward untouched to CDN & enqueue background download
      if (hit) {
        try {
          postCdnObservation(parsed, rangeTuple, "fetch", `matched_${hit.kind}`);
          enqueueMiss(hit, rangeTuple, "fetch");
        } catch (_) {}
      }

      const p = origFetch.apply(selfThis, origArgs);
      try {
        if (rawUrl && PLAYURL_API_RE.test(rawUrl) && p && typeof p.then === "function") {
          return p.then(async (res) => {
            try {
              if (res && res.ok) {
                const j = await res.clone().json();
                if (j && j.data && j.data.dash) {
                  registerDashTracks(j.data.dash);
                  if (preferCachedTracksInPlayData(j.data, rawUrl)) {
                    const hdrs = new Headers(res.headers);
                    hdrs.delete("content-length");
                    hdrs.delete("content-encoding");
                    return new Response(JSON.stringify(j), {
                      status: res.status,
                      statusText: res.statusText,
                      headers: hdrs,
                    });
                  }
                }
              }
            } catch (_) {}
            return res;
          });
        }
      } catch (_) {}
      return p;
    };
  }

  // =========================================================================
  // 2) Wrap XMLHttpRequest (Proxy-on-Hit / Native-on-Miss — critical for Bilibili)
  // =========================================================================
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;
  const origAbort = XMLHttpRequest.prototype.abort;
  const origResponseTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
  const origResponseDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response");

  function attachPlayurlXhrInterceptor(xhr, requestUrl) {
    if (!origResponseTextDesc || !origResponseDesc) return;
    let evaluated = false;
    let rewrittenText = null;
    let rewrittenObj = null;

    const evaluateOnce = () => {
      if (evaluated) return;
      if (xhr.readyState !== 4 || xhr.status !== 200) return;
      evaluated = true;
      try {
        const rt = xhr.responseType || "";
        let j = null;
        if (rt === "" || rt === "text") {
          const rawText = origResponseTextDesc.get.call(xhr);
          if (rawText) j = JSON.parse(rawText);
        } else if (rt === "json") {
          const rawObj = origResponseDesc.get.call(xhr);
          if (rawObj && typeof rawObj === "object") {
            j = JSON.parse(JSON.stringify(rawObj));
          }
        }
        if (j && j.data && j.data.dash) {
          registerDashTracks(j.data.dash);
          if (preferCachedTracksInPlayData(j.data, requestUrl)) {
            rewrittenObj = j;
            rewrittenText = JSON.stringify(j);
            console.log(`[rb-cache][playurl-align] converged to cached quality=${j.data.quality}`);
          }
        }
      } catch (_) {}
    };

    xhr.__rbShadowed = true;
    Object.defineProperty(xhr, "responseText", {
      configurable: true,
      enumerable: true,
      get() {
        evaluateOnce();
        if (rewrittenText !== null) return rewrittenText;
        return origResponseTextDesc.get.call(this);
      },
    });
    Object.defineProperty(xhr, "response", {
      configurable: true,
      enumerable: true,
      get() {
        evaluateOnce();
        const rt = this.responseType || "";
        if (rt === "json" && rewrittenObj !== null) return rewrittenObj;
        if ((rt === "" || rt === "text") && rewrittenText !== null) return rewrittenText;
        return origResponseDesc.get.call(this);
      },
    });
  }

  const XHR_SHADOW_PROPS = [
    "readyState",
    "status",
    "statusText",
    "response",
    "responseText",
    "responseURL",
    "getResponseHeader",
    "getAllResponseHeaders",
  ];

  function clearXhrShadowProps(xhr) {
    if (!xhr.__rbShadowed) return;
    for (const prop of XHR_SHADOW_PROPS) {
      try {
        delete xhr[prop];
      } catch (_) {}
    }
    xhr.__rbShadowed = false;
  }

  function defineXhrValue(xhr, prop, value) {
    Object.defineProperty(xhr, prop, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }

  function serveXhrFromLocal(xhr, hit, rangeTuple, savedSendArgs) {
    const method = xhr.__rbMethod || "GET";
    const localUrl = buildLocalUrl(hit.videoKey);
    const controller = new AbortController();
    const proxyState = { controller, aborted: false, active: true };
    xhr.__rbProxy = proxyState;

    let timeoutId = null;
    if (typeof xhr.timeout === "number" && xhr.timeout > 0) {
      timeoutId = window.setTimeout(() => {
        if (!proxyState.active || proxyState.aborted) return;
        proxyState.aborted = true;
        proxyState.active = false;
        controller.abort();
        xhr.__rbShadowed = true;
        defineXhrValue(xhr, "readyState", 4);
        defineXhrValue(xhr, "status", 0);
        defineXhrValue(xhr, "statusText", "");
        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(new ProgressEvent("timeout"));
        xhr.dispatchEvent(new ProgressEvent("loadend"));
      }, xhr.timeout);
    }

    const cleanupTimer = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const fallbackToNative = (isNetworkErr) => {
      cleanupTimer();
      proxyState.active = false;
      xhr.__rbProxy = null;
      if (proxyState.aborted) return;

      if (isNetworkErr) {
        markLocalServerDown();
      } else {
        invalidateLocalRange(hit.videoKey, rangeTuple);
      }
      STATS.fallbacks++;
      try {
        enqueueMiss(hit, rangeTuple, "xhr");
      } catch (_) {}
      // Original XHR is still cleanly in OPENED state with all headers & listeners intact!
      origSend.apply(xhr, savedSendArgs);
    };

    origFetch
      .call(window, localUrl, {
        method,
        headers: buildLocalRangeHeaders(rangeTuple),
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      })
      .then(async (res) => {
        if (proxyState.aborted) {
          cleanupTimer();
          return;
        }
        if (res.status !== 200 && res.status !== 206) {
          fallbackToNative(false);
          return;
        }

        const respType = xhr.responseType || "";
        const headerMap = new Map();
        const headerLines = [];
        res.headers.forEach((val, key) => {
          headerMap.set(key.toLowerCase(), val);
          headerLines.push(`${key.toLowerCase()}: ${val}`);
        });
        const allHeadersStr = headerLines.length ? `${headerLines.join("\r\n")}\r\n` : "";

        let payload = null;
        let payloadText = "";
        let byteLength = 0;

        if (method === "HEAD") {
          payload = respType === "arraybuffer" ? new ArrayBuffer(0) : "";
          byteLength = 0;
        } else if (respType === "arraybuffer") {
          payload = await res.arrayBuffer();
          byteLength = payload.byteLength;
        } else if (respType === "blob") {
          payload = await res.blob();
          byteLength = payload.size;
        } else if (respType === "json") {
          const text = await res.text();
          byteLength = text.length;
          try {
            payload = JSON.parse(text);
          } catch (_) {
            payload = null;
          }
        } else {
          const buf = await res.arrayBuffer();
          byteLength = buf.byteLength;
          payloadText = new TextDecoder("utf-8", { fatal: false }).decode(buf);
          payload = payloadText;
        }

        if (proxyState.aborted) {
          cleanupTimer();
          return;
        }

        cleanupTimer();
        proxyState.active = false;
        xhr.__rbProxy = null;

        const clHeader = parseInt(headerMap.get("content-length") || "", 10);
        const totalForProgress = Number.isFinite(clHeader) && clHeader > 0 ? clHeader : byteLength;

        xhr.__rbShadowed = true;
        defineXhrValue(xhr, "status", res.status);
        defineXhrValue(xhr, "statusText", res.statusText || (res.status === 206 ? "Partial Content" : "OK"));
        defineXhrValue(xhr, "responseURL", xhr.__rbUrl || localUrl);
        defineXhrValue(xhr, "getResponseHeader", (name) => {
          if (!name) return null;
          const v = headerMap.get(String(name).toLowerCase());
          return v !== undefined ? v : null;
        });
        defineXhrValue(xhr, "getAllResponseHeaders", () => allHeadersStr);

        // Stage 2: HEADERS_RECEIVED
        defineXhrValue(xhr, "readyState", 2);
        xhr.dispatchEvent(new Event("readystatechange"));
        if (proxyState.aborted) return;

        // Stage 3: LOADING + progress
        defineXhrValue(xhr, "readyState", 3);
        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(
          new ProgressEvent("progress", {
            lengthComputable: totalForProgress > 0,
            loaded: byteLength,
            total: totalForProgress,
          })
        );
        if (proxyState.aborted) return;

        // Stage 4: DONE + load + loadend
        defineXhrValue(xhr, "response", payload);
        if (respType === "" || respType === "text") {
          defineXhrValue(xhr, "responseText", payloadText);
        }
        defineXhrValue(xhr, "readyState", 4);

        STATS.hits++;
        STATS.xhrHits++;
        STATS.hitBytes += byteLength;
        console.log(
          `[rb-cache][HIT xhr ${res.status}] ${hit.videoKey} range=${rangeTuple ? `${rangeTuple[0]}-${rangeTuple[1] ?? ""}` : "full"} (${byteLength} B)`
        );

        xhr.dispatchEvent(new Event("readystatechange"));
        xhr.dispatchEvent(
          new ProgressEvent("load", {
            lengthComputable: totalForProgress > 0,
            loaded: byteLength,
            total: totalForProgress,
          })
        );
        xhr.dispatchEvent(
          new ProgressEvent("loadend", {
            lengthComputable: totalForProgress > 0,
            loaded: byteLength,
            total: totalForProgress,
          })
        );
      })
      .catch((err) => {
        if (proxyState.aborted || (err && err.name === "AbortError")) {
          cleanupTimer();
          return;
        }
        fallbackToNative(true);
      });
  }

  XMLHttpRequest.prototype.open = function (method, url, async) {
    try {
      clearXhrShadowProps(this);
      if (this.__rbProxy && this.__rbProxy.active) {
        this.__rbProxy.aborted = true;
        this.__rbProxy.active = false;
        try {
          this.__rbProxy.controller.abort();
        } catch (_) {}
      }
      this.__rbProxy = null;
      this.__rbMethod = String(method || "GET").toUpperCase();
      this.__rbUrl = typeof url === "string" ? url : url ? String(url) : "";
      this.__rbAsync = async !== false;
      this.__rbRange = null;
    } catch (_) {}
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (typeof name === "string" && name.toLowerCase() === "range") {
        this.__rbRange = parseRangeHeader(String(value || ""));
      }
    } catch (_) {}
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.abort = function () {
    const proxy = this.__rbProxy;
    if (proxy && proxy.active) {
      proxy.aborted = true;
      proxy.active = false;
      this.__rbProxy = null;
      try {
        proxy.controller.abort();
      } catch (_) {}
      try {
        this.__rbShadowed = true;
        defineXhrValue(this, "readyState", 4);
        defineXhrValue(this, "status", 0);
        defineXhrValue(this, "statusText", "");
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new ProgressEvent("abort"));
        this.dispatchEvent(new ProgressEvent("loadend"));
        defineXhrValue(this, "readyState", 0);
      } catch (_) {}
      return;
    }
    return origAbort.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const savedSendArgs = Array.prototype.slice.call(arguments);
    try {
      const url = this.__rbUrl;
      if (url && !url.startsWith(LOCAL_ORIGIN) && !drmDetected) {
        const parsed = parseSafeUrl(url);
        if (parsed) {
          const rangeTuple = parseRange(parsed, this.__rbRange);
          const hit = matchCdn(parsed);

          // Local cache HIT path for async GET/HEAD XHR
          if (
            hit &&
            this.__rbAsync &&
            (this.__rbMethod === "GET" || this.__rbMethod === "HEAD") &&
            isMainPlaybackContext() &&
            localHas(hit, rangeTuple)
          ) {
            serveXhrFromLocal(this, hit, rangeTuple, savedSendArgs);
            return;
          }

          // Miss path
          if (hit) {
            postCdnObservation(parsed, rangeTuple, "xhr", `matched_${hit.kind}`);
            enqueueMiss(hit, rangeTuple, "xhr");
          } else if (BILI_HOST_RE.test(parsed.hostname)) {
            postCdnObservation(parsed, rangeTuple, "xhr", "bilivideo_non_m4s");
          }
        }

        // Playurl metadata sniffer + cached-track default quality alignment
        if (PLAYURL_API_RE.test(url)) {
          attachPlayurlXhrInterceptor(this, url);
        }
      }
    } catch (_) {}
    return origSend.apply(this, savedSendArgs);
  };

  // =========================================================================
  // 3) Passive HTMLMediaElement.src audit for bilivideo CDN
  // =========================================================================
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    if (desc && typeof desc.set === "function") {
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (val) {
          try {
            if (typeof val === "string" && !val.startsWith("blob:") && !val.startsWith(LOCAL_ORIGIN)) {
              const u = parseSafeUrl(val);
              if (u && BILI_HOST_RE.test(u.hostname)) {
                postCdnObservation(u, null, `media_${(this.tagName || "el").toLowerCase()}_src`, "media_src");
              }
            }
          } catch (_) {}
          return desc.set.call(this, val);
        },
      });
    }
  } catch (_) {}

  // Ask ISOLATED-world relay for fresh ranges right away at document_start
  requestRangesSync();

  window.__RB_CACHE_DEBUG__ = {
    localOrigin: LOCAL_ORIGIN,
    matchCdn: (raw) => matchCdn(parseSafeUrl(raw)),
    isCovered,
    localHas: (videoKey, start, end) => localHas({ videoKey }, start === undefined ? null : [start, end ?? null]),
    isDrmDetected: () => drmDetected,
    getActiveTracks: () => Array.from(ACTIVE_TRACKS),
    getPendingTracks: () => Array.from(PENDING_INIT.keys()),
    getKnownTrackMetaCount: () => TRACK_META_BY_PATH.size,
    getRangesSnapshot: () => JSON.parse(JSON.stringify(RANGE_SNAP)),
    setRangesSnapshot: (raw) => {
      RANGE_SNAP = normalizeRangeSnap(raw);
      HIT_MEM.clear();
      localServerDownUntil = 0;
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(RANGE_SNAP));
      } catch (_) {}
    },
    setRedirectEnabled: (enabled) => {
      redirectEnabled = Boolean(enabled);
    },
    requestRangesSync,
    getStats: () => ({
      ...STATS,
      rangeTrackCount: Object.keys(RANGE_SNAP).length,
      redirectEnabled,
      serverDown: Date.now() < localServerDownUntil,
    }),
  };
})();
