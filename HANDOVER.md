# 交接文档 · web-video-beauty-mv3

> 最后更新：2026-11-24
> 项目路径：`E:\codex\2026-11-22\wo-x\work\web-video-beauty-mv3`
> 平台：Windows / Chrome MV3 扩展 + Python FastAPI 本地服务

---

## 1. 这是什么

一个给网页视频做**实时美颜** + **本地缓存** + **自带播放器回看**的 Chrome 扩展 + 本地服务。

三块能力：

| 能力 | 状态 |
|---|---|
| 26 项实时美颜（WebGL + MediaPipe 478 点） | ✅ 原有，稳定 |
| 视频本地缓存（三层） | ✅ v4 透明缓存跑通 |
| 本地媒体库 + 内置播放器（带美颜） | ✅ **2026-11-24 新增，已实测** |

**目标站点**：MissAV、Javrate、Avbebe（成人视频站，全部无 DRM，明文 HLS）

**最终目标**（尚未完成）：缓存人脸关键点，让美颜在播放时**永不掉妆**。

---

## 2. 当前状态总览

```
✅ 美颜引擎         26 项效果、7 档预设、中文配方解析、XGPlayer/Plyr/B站/YouTube 适配
✅ 本地缓存服务     FastAPI，curl_cffi 传输，ffmpeg 合并，LRU 清理
✅ v4 透明缓存      三家站点实测跑通（边看边存，零额外流量）
✅ 本地媒体库       GET /  列出所有已缓存视频（缩略图/进度/删除）
✅ 内置播放器       GET /play/{key}  离线播放 + 全套美颜面板，一行没改美颜代码
✅ 域名白名单       grab-hook 只注入三家站点，不再影响无关网站
⬜ 关键点预扫       未开始（原始设计文档的核心目标，见 7.2）
```

**服务当前状态**：正在 `127.0.0.1:8765` 运行（需手动启动）。

---

## 3. 架构

### 3.1 三层缓存并存

| 层 | 覆盖 | 代码 | 状态 |
|---|---|---|---|
| **v2** | B站 / YouTube（MSE 流） | `content/cache-hook.js` + `storage.py` + `downloader.py` | 原有，保留 |
| **v3** | 任意站整片下载 | `grab_pipeline.py` + `content/grab-hook.js`(旧) | 保留为「离线保存」底座 |
| **v4** | MissAV / Javrate / Avbebe 透明缓存 | `hls_proxy.py` + `content/grab-hook.js`(当前) | 稳定 |

### 3.2 v4 数据流（网页播放）

```
┌──────── 页面 (MAIN world, all_frames) ────────┐
│ grab-hook.js                                    │
│   域名白名单过滤 → 拦截 window.Hls 的赋值       │
│   把 m3u8 URL 改写成 127.0.0.1 本地代理         │
└────────────────┬───────────────────────────────┘
                 │ 播放器请求本地 m3u8
┌────────────────▼───────────────────────────────┐
│ 本地服务 :8765                                   │
│   GET /hls/{key}/master.m3u8  → 拉原始、留最高档 │
│   GET /hls/{key}/v/0.m3u8     → 分片地址全改写   │
│   GET /hls/{key}/seg/{idx}    → 命中/回源        │
└────────────────┬───────────────────────────────┘
                 │
        ~/Videos/grab-cache/<safeKey>/
          meta.json          统计（几百字节）
          segments.txt       分片 URL 索引（一行一个）
          segs/000000.ts      分片实体
          v/0.m3u8           playlist 快照（原始，含 EXTINF）
          thumb.jpg          缩略图（首次访问时 ffmpeg 抽帧）
```

### 3.3 本地播放器数据流（**新增**）

关键点：**播放列表完全由磁盘状态生成，不回源、不需要原站 token**。

```
浏览器 → GET /play/{safeKey}            player.html
       → GET /api/library               列表（标题/时长/进度）
       → GET /api/library/{key}/segments 逐片时长 + 已缓存区间
       → GET /l/{key}/index.m3u8?mode=cached
              │
              └─ 服务端读 segments.txt + v/0.m3u8，现场拼 playlist
                 分片行全部指向 /hls/{key}/seg/{idx}
       → GET /hls/{key}/seg/{idx}        命中本地文件 → 10ms 返回
```

`mode` 两种：

| mode | 列出 | 用途 |
|---|---|---|
| `cached`（默认） | 只列已落盘分片 | **真正离线**，token 过期也能看 |
| `all` | 全部 374 片 | 边看边续缓存，未命中的回源拉 |

想「续缓存」就把 URL 加 `?mode=all`。

---

## 4. 代码地图

### 4.1 扩展侧

| 文件 | 行数 | 职责 |
|---|---|---|
| `manifest.json` | 135 | MV3 配置。grab-hook **只注入三家站点**（已收窄） |
| `content/grab-hook.js` | ~330 | **v4 核心**。域名白名单 + hook `Hls.loadSource` + 原生 `video.src` |
| `content/grab-relay.js` | 140 | ISOLATED world 桥接，把 pageKey / keys / serverOnline 同步给 MAIN |
| `background/grab-bridge.js` | 200 | 每 60 秒同步 `/api/keys`，提供 `rb-grab-init` |
| `content/engine.js` | 2700+ | 美颜渲染引擎（WebGL 26 项）。**同时被本地播放器页复用** |
| `content/overlay-ui.js` | 1600+ | 美颜悬浮面板。**同时被本地播放器页复用** |
| `worker/face-worker.js` | 452 | MediaPipe 478 点检测（Web Worker） |
| `content/cache-hook.js` | — | v2 的 B站/YouTube hook（保留不动） |

### 4.2 服务侧

| 文件 | 行数 | 职责 |
|---|---|---|
| `cache-server/webui.py` | ~470 | **新增**。媒体库 + 播放器 + 本地 playlist + 静态资源 + 缩略图 |
| `cache-server/hls_proxy.py` | ~570 | **v4 核心**。透明缓存全部逻辑 |
| `cache-server/server.py` | ~440 | FastAPI 路由（v2 + v3 + v4 + webui 全挂在这） |
| `cache-server/config.py` | ~85 | 所有配置项 |
| `cache-server/grab_pipeline.py` | 1368 | v3 整片下载管道（curl_cffi + ffmpeg） |
| `cache-server/storage.py` | 598 | v2 稀疏文件存储 |
| `cache-server/downloader.py` | 249 | v2 Range 下载器 |

### 4.3 播放器前端（**新增**）

| 文件 | 职责 |
|---|---|
| `cache-server/web/library.html` | 媒体库页，卡片网格 + 缩略图 + 进度 + 删除 |
| `cache-server/web/player.html` | 播放器页，hls.js + 缓存区间条 + 键盘快捷键 |
| `cache-server/web/shim.js` | **chrome.\* 垫片**，让扩展版 engine.js 在普通网页跑 |
| `cache-server/web/app.css` | 两页共用样式（暗色） |
| `cache-server/web/vendor/hls.min.js` | hls.js 1.5.20 本地副本（415KB，Chrome 不支持原生 HLS） |

**shim 只垫三处**（已核对源码，别多加）：

```
engine.js:1627   chrome.runtime.getURL("worker/face-worker.js")
engine.js:1628   chrome.runtime.getURL("vendor/mediapipe/")
engine.js:2592   chrome.runtime.onMessage.addListener(...)
overlay-ui.js    chrome.storage.local.get / set
```

播放器页脚本顺序**不能改**：`hls.min.js → shim.js → engine.js → overlay-ui.js`。

---

## 5. 怎么跑

### 5.1 首次准备

```bash
cd E:/codex/2026-11-22/wo-x/work/web-video-beauty-mv3/cache-server
pip install -r requirements.txt          # fastapi uvicorn curl_cffi pydantic
# ffmpeg：winget install Gyan.FFmpeg（config.py 会自动探测，缩略图也靠它）
```

### 5.2 启动服务

```bash
cd cache-server
./.venv/Scripts/python.exe main.py
# 或后台：nohup python main.py > /tmp/rb.log 2>&1 &
```

### 5.3 用本地播放器（不装扩展也能看）

浏览器打开 `http://127.0.0.1:8765/`：

- 媒体库列出所有已缓存视频，点「播放」进入播放器
- 播放器页自带全套美颜面板（右下角悬浮球）
- 快捷键：`空格` 播放/暂停、`←/→` ±5 秒、`F` 全屏、`M` 静音
- 全屏用 `#stage` 而不是 `<video>`，**这样全屏也保留美颜**（engine 在 `fsElement===video` 时会回退原生）

### 5.4 重载扩展

改动扩展代码后必须重载，否则跑的是旧代码：

1. 打开 `chrome://extensions`
2. 开「开发者模式」
3. 点该扩展的刷新按钮

**注意**：ego-browser 的扩展列表在 `ego://extensions`。

### 5.5 验证

```bash
curl http://127.0.0.1:8765/health
# 应看到 "stage":"v4-transparent-hls" 和 hlsStats

curl http://127.0.0.1:8765/api/library
# 应看到 items 数组，每项含 cachedSegments / totalSegments / durationSec

curl "http://127.0.0.1:8765/l/<safeKey>/index.m3u8?mode=cached"
# 应看到 #EXTM3U ... /hls/<safeKey>/seg/0 ...
```

---

## 6. 已验证的实测结论（**别重新踩一遍**）

### 6.1 三家站点参数

| 项 | MissAV | Javrate | Avbebe |
|---|---|---|---|
| 页面 | `missav.ws/{dvd_id}` | `javrate.com/movie/detail/{uuid}.html` | `avbebe.com/archives/{post_id}` |
| 播放器 | hls.js 1.4.3 + plyr | 自研 iframe `/player/v2?payload=…` | flowplayer + hls.js 1.4.10 |
| `video.src` | `blob:` | `blob:` | `blob:` |
| **m3u8 来源** | `surrit.com/{uuid}/playlist.m3u8` | `cloud-hot-2.avking.xyz/{date}/{uuid}/playlist.m3u8?token=…` | `52cute.com/acg/watch/{post_id}/playlist.m3u8` |
| 分片 | `video{N}.jpeg`（伪装）710KB/4s | `video{N}.ts` 490KB/4s | `file{N}.ts` 2.2MB/5s |
| 加密 | 无 | 无 | 无 |
| 鉴权 | 无 | **URL 内 token，10–30 分钟过期** | 无 |
| Cloudflare | **有，必须 impersonate** | 无 | 无 |

### 6.2 关键实测数据

```
MissAV 720p：
  分片 628KB × 3589 片（4 小时片子）
  下载速度 4.6 MB/s（6 并发）
  未命中 → 400–1200ms
  命中   → 13–55ms（快 20–40 倍）

验证过的完整链路：
  播放 20 秒 → 缓存 19 片
  重开页面 → hits 16→33（前面分片全走本地）
  拖到 1 小时 → t=3611, readyState=4, 无错误

本地播放器（2026-11-24，avbebe 130 片 / javrate 5 片）：
  播放列表生成      7543 字节（130 片），21695 字节（374 片）
  分片命中          10ms（403KB）
  拖动到 t=400s     readyState=4，无 error
  美颜渲染          renderMode=face_mask，renderFps=30，detectFps=30，inferMs=21.9
  MediaPipe worker  "就绪 (GPU · 零滞后帧同步)"
  缩略图            ffmpeg 抽帧 14KB jpg，前端 0 报错
```

### 6.3 六条血泪教训

| # | 坑 | 说明 |
|---|---|---|
| 1 | **`blob:` 不是退出条件** | 三家全是 `blob:`（都用了 hls.js），媒体在 XHR/fetch 层，照常能抓。曾经写「见到 blob 就退出」，结果三家全废 |
| 2 | **绝不剥分片头** | MissAV 的 `.jpeg` 分片是纯 TS：`628484 ÷ 188 = 3343.0` 整除、首字节 `0x47`。任何「剥离伪装头」都会切坏包边界 → 花屏 |
| 3 | **`urljoin` 会丢 query** | Javrate 的签名是路径级（`token_path=/uuid/`），相对路径 `720p/video.m3u8` 经 urljoin 后 token 没了 → 403。必须 `inherit_query()` |
| 4 | **`meta.json` 会膨胀** | 3589 个分片 URL 塞进去 = 402KB，每次读写真慢。拆成 `segments.txt` 后 = 508 字节 |
| 5 | **Cloudflare 看 TLS 指纹** | Node fetch / requests / ffmpeg 直连一律 403，加什么 header 都没用。必须 `curl_cffi impersonate="chrome"` |
| 6 | **并发别超 8** | 实测 6 并发 4.6MB/s 稳定，12 并发触发限速 |

### 6.4 站点自身的坑

- **MissAV 部分 CDN 桶返回 `BucketPunish`**（阿里云 OSS 欠费/超限），换一个视频往往就好。这是站点问题，不是我们的 bug。
- **Javrate token 10–30 分钟过期**，必须从页面实时抓，不能缓存 URL。这也正是「只列已缓存分片」模式的必要性：token 一过期，`mode=all` 就废，`mode=cached` 照样能看。
- **Avbebe 需要点击播放器**才初始化（flowplayer 懒渲染）。
- **Avbebe 的 m3u8 不是 master**（没有 `#EXT-X-STREAM-INF`），所以 `meta.resolution` / `meta.bandwidth` 为空。MissAV/Javrate 是 master，有值。

### 6.5 本地播放器的四个坑（2026-11-24 新增）

| # | 坑 | 说明 |
|---|---|---|
| 1 | **Blob worker 里 `import("/xxx")` 必炸** | `engine.js` 把 worker 源码包成 Blob 再 `new Worker(blobUrl,{type:"module"})`。`blob:` 的 base 没有 host，worker 内 `import("/static/vendor/...")` 报 `Failed to resolve module specifier`，直接退化成「肤色回退」。**shim 的 `getURL` 必须返回带 origin 的完整 URL**（`location.origin + "/static/..."`），这等价于扩展里的 `chrome-extension://...` |
| 2 | **`cachedCount` 会虚高** | `_touch_cached` 是增量 `+=1`，并发预取/重试同一片会重复累加。实测 meta 记 95，磁盘真实 90。**对外报进度一律用磁盘扫描**（`hls_proxy.scan_cached()` / `webui._scan_segs()`），别信 meta |
| 3 | **长片不限制回缓冲会吃满内存** | 4 小时片子默认 backBuffer 无限增长。播放器里设 `backBufferLength: 90, maxBufferLength: 30` |
| 4 | **engine 默认 `enabled=false`** | 它靠 `chrome.runtime.onMessage` 收 `WVB_SET_ENABLED` 才开。本地页没有 SW 推消息，必须自己调 `__WVB_ENGINE__.setEnabled(true)`，并且要等 `loadedmetadata` 之后 |

---

## 7. 未完成 / 下一步

### 7.1 ~~域名白名单~~ ✅ 已完成（2026-11-24）

`content/grab-hook.js` 开头加了 host 白名单：

```js
const ALLOW_HOST = /(^|\.)(missav\.[a-z]+|javrate\.[a-z]+|avbebe\.[a-z]+|52cute\.com|avking\.xyz|surrit\.com)$/i;
if (!ALLOW_HOST.test(location.hostname)) return;
```

`manifest.json` 的 `grab-hook` / `grab-relay` matches 也从 `<all_urls>` 收窄到三家站点。

已用 18 条用例验证：`www.javrate.com` 通过（iframe host），`missav.ws.evil.com` 被拒（后缀伪造），`bilibili.com` / `iqiyi.com` / `v.qq.com` 全部跳过。

**注意**：`content/engine.js` + `overlay-ui.js` 仍是 `<all_urls>`（美颜是全站能力，故意保留）。

### 7.2 ~~本地播放器页面~~ ✅ 已完成（2026-11-24）

```
GET /                     媒体库
GET /play/{safeKey}       播放器（video + 美颜面板）
GET /l/{key}/index.m3u8   本地生成 playlist（mode=cached|all）
GET /api/library          列表 JSON
GET /api/library/{key}/segments  逐片时长 + 已缓存区间
GET /thumb/{key}          ffmpeg 抽帧缩略图
DELETE /api/library/{key} 删本地缓存
```

美颜代码（`engine.js` / `overlay-ui.js`）**一行没改**，靠 `shim.js` 垫住 chrome API 直接复用。

**遗留小项**：

- `mode=all` 时如果遇到 token 过期，hls.js 会卡在某个分片。可以考虑「跳过失败分片」或「自动降级到 cached 模式」。
- 缩略图抽帧是同步阻塞的（ffmpeg 25s 超时）。并发点开很多卡片时可能卡。可以改成后台队列。

### 7.3 【核心目标】关键点预扫

这是原始设计文档（`realtime_beauty_cache_design.md`）的核心，目的是**让美颜永不掉妆**。

**为什么现在做比之前容易**：原方案要 hook MSE + 写 fMP4 解封装 + WebCodecs，**这些现在全不用了**，因为视频已经在本地磁盘上，而且 7.2 已经把「只列已缓存分片的播放列表」做出来了（就是 `/l/{key}/index.m3u8?mode=cached`，第 1 步已完成）。

**方案**（全部在播放器页里做，不需要扩展）：

1. ~~本地服务加 `GET /playback/{key}/index.m3u8` 只列已缓存分片~~ → **已完成**，用 `mode=cached`
2. 播放器页建一个隐藏 `<video>`，指向 `mode=all` 的 playlist（保持完整时间轴），10fps 抽帧跑现有 `face-worker.js`
3. 结果按 `mediaTime` 存 IndexedDB，**坐标用 Int16 量化**（`Float32` 太肥：478 点 × 2 × 4B × 10fps × 4h ≈ 550MB；Int16 后约 275MB，若降到 5fps 约 138MB）
4. `engine.js` 的 `requestVideoFrameCallback` 里查表：命中用缓存，未命中回退实时推理
5. 进阶：Gap Filling（转头 300ms 空窗用前后帧插值补上）

**预估**：2–3 天。先做「查表 + 回退」，效果就出来一大半，插值后加。

**注意**：预扫用 `mode=all` 会顺带把未缓存分片拉下来（等于边扫边缓存），这是好事；但 Javrate 的 token 过期后会失败，此时降级成 `mode=cached` 只扫已有段（时间轴会被压缩，要重新对齐）。

### 7.4 其他待办

- 服务开机自启（现在手动 `python main.py`）
- 缓存管理 UI 增强（批量删、按大小排序、搜索）——基础版已有
- v3 整片下载改成「离线保存」按钮（代码在，缺入口）
- `mode=all` 的分片失败容错

---

## 8. 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 本地服务没开 | 网页播放会黑屏；播放器页直接打不开 | `grab-hook.js` 里的 `serverOnline` 守卫，探测失败不改写 |
| 全站注入 | ~~影响无关网站~~ | ✅ 已修为域名白名单 |
| MV3 SW 被回收 | 后台状态丢失 | 状态全在本地服务，扩展无状态 |
| Javrate token 过期 | `mode=all` 续缓存失败 | `mode=cached` 不受影响，永远能看已缓存部分 |
| MissAV 桶被罚 | 部分视频无法缓存 | 换视频重试，非 bug |
| 缩略图阻塞 | 卡片多时首屏慢 | ffmpeg 25s 超时 + 失败返回 404，前端有占位 |

---

## 9. 调试手册

### 9.1 看缓存状态

```bash
curl -s http://127.0.0.1:8765/health | python -m json.tool
curl -s http://127.0.0.1:8765/api/library | python -m json.tool
curl -s "http://127.0.0.1:8765/api/video/<safeKey>" | python -m json.tool
curl -s "http://127.0.0.1:8765/api/videos?scope=v3" | python -m json.tool
```

### 9.2 看播放列表

```bash
# 只列已缓存（离线可用）
curl -s "http://127.0.0.1:8765/l/<safeKey>/index.m3u8?mode=cached" | head -20

# 全部（会回源）
curl -s "http://127.0.0.1:8765/l/<safeKey>/index.m3u8?mode=all" | grep -c EXTINF

# 已缓存区间
curl -s "http://127.0.0.1:8765/api/library/<safeKey>/segments" | python -m json.tool
```

### 9.3 看磁盘

```bash
ls ~/Videos/grab-cache/                    # 所有视频
ls ~/Videos/grab-cache/<safeKey>/segs | wc -l   # 分片数
xxd -l 1 ~/Videos/grab-cache/<safeKey>/segs/000000.ts   # 应是 47
```

### 9.4 浏览器内调试（网页侧）

扩展在页面注入的调试对象：

```js
window.__RB_HLS_DEBUG__.getStats()      // {rewritten, v3Hit, skippedOffline}
window.__RB_HLS_DEBUG__.getSafeKey()
window.__RB_HLS_DEBUG__.isServerOnline()
window.__RB_HLS_DEBUG__.toLocalPlaylist(url)  // 手动测试改写
```

### 9.5 浏览器内调试（播放器页）

```js
window.__WVB_ENGINE__.getStateSnapshot()
// 关键看：
//   renderMode    face_mask（真脸遮罩）/ skin_fallback（没检测到脸，正常降级）
//   workerStatus  应含「就绪 (GPU · 零滞后帧同步)」；若含「不可用」→ shim 的 getURL 返错了
//   diagnostics.renderFps / detectFps / inferMs
window.__WVB_DESKTOP_UI_CTRL__.openPanel()   // 强制打开美颜面板
window.__RB_CHROME_SHIM__                     // 应为 true
document.getElementById('badge').textContent  // 仅本地 · 130/374 片 · 35%
```

### 9.6 服务端日志

关键行格式：

```
[hls][master]    <key> -> 1280x720 (bw=4709877) variants->1
[hls][media]     <key> segments=3589 dur/seg=4.00s cached=0
[hls][seg]       <key>#123 failed: ...
[hls][warn]      <key> has EXT-X-KEY ...
[webui][playlist] <key> mode=cached segments=130 (0..129) dur=650.0s
[webui][delete]  <key> -> True
```

### 9.7 safeKey 计算（前后端必须一致）

```
页面 https://missav.ws/dandy-884-uncensored-leak
  → pageKey  missav.ws/dandy-884-uncensored-leak
  → safeKey  missav.ws_dandy-884-uncensored-leak
```

规则：`hostname + pathname` 去掉尾部斜杠，把 `[^\w.\-/]` 换成 `_`，再把 `/` 换成 `_`，最后去掉首尾的 `.` 和 `_`。

实现在两处，改一处必须同步改另一处：
- `cache-server/hls_proxy.py` → `safe_key_of()`
- `content/grab-hook.js` → `safeKeyOf()`

---

## 10. 配置项速查

```bash
# 服务端（环境变量）
RB_CACHE_PORT=8765
RB_GRAB_CACHE_DIR=~/Videos/grab-cache
RB_HLS_PREFERRED_HEIGHT=720     # 选档上限，0=最高档
RB_HLS_PREFETCH=3               # 预取片数，>3 退化成整片下载
RB_HLS_MAX_FETCH=4              # 全局并发，别超 8
RB_HLS_PROXY=false              # 关掉透明缓存，回到 v3
RB_GRAB_IMPERSONATE=chrome      # curl_cffi 指纹
```

---

## 11. 红线（改代码前必读）

1. **不要给分片「剥离伪装头」** —— 三家都是纯 TS，剥了必花屏
2. **不要写死 `-map 0:v -map 1:a`** —— 三家都是音视频合流单轨
3. **不要用 `blob:` 当「不可缓存」的判据** —— 三家全是 blob
4. **不要让 ffmpeg 直连远程 URL** —— 会 403，必须 curl_cffi 先落地
5. **不要超过 8 并发** —— 触发 CDN 限速
6. **不要用 `httpx` / `requests` 抓 CDN** —— MissAV 挡 TLS 指纹
7. **改 `loadSource` 时不要在里 await 网络请求** —— 会卡住播放器
8. **播放器页的脚本顺序不能改** —— `hls.min.js → shim.js → engine.js → overlay-ui.js`
9. **shim 的 `getURL` 必须返回完整 origin** —— 否则 Blob worker 里 `import()` 解析失败，美颜静默降级成肤色回退
10. **进度/大小一律以磁盘扫描为准** —— `meta.cachedCount` / `cachedBytes` 是增量值，会虚高

---

## 12. 参考文档

- `video-cache-spec-v3.md` —— v3 整片下载规格（第 0 节的实测数据仍有效）
- `video-cache-spec-v4.md` —— v4 透明缓存规格
- `realtime_beauty_cache_design.md` —— 关键点预扫的原始设计（第 2 节、4.4 节仍有效）
