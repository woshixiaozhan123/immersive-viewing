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
| 26 项实时美颜（WebGL + MediaPipe 478 点） | ✅ 原有，稳定，全站生效 |
| 视频本地缓存（三层） | ✅ v4 透明缓存跑通 |
| **原站内嵌播放器控制条** | ✅ **主路径**：不新开页面，直接在目标站原视频上套我们的控制条 |
| 本地媒体库 + 独立播放器页 | ✅ 保留为**离线兜底**（token 过期 / 原站打不开时回看） |

**目标站点**：MissAV、Javrate、Avbebe（成人视频站，全部无 DRM，明文 HLS）

**最终目标**（尚未完成）：缓存人脸关键点，让美颜在播放时**永不掉妆**。

> ⚠️ **方向约定（2026-11-24 用户明确）**
> 1. 抖音 / B站 / YouTube **保留它们自带的播放器**，只叠加美颜层，**默认不接管它们的控制条**。
> 2. 那三个目标站播放器简陋，**在原页面里**套我们自己的控制条，**不要跳到 127.0.0.1 单开网页**。
> 3. 本地媒体库页只作为兜底入口存在，不是主交互路径。
> 4. 控制条**不做站点硬限制**：全站注入，谁能用由用户开关决定，按域名记忆。
> 5. 缓存**也不做站点硬限制、也不自动全存**：默认全关，用户自己在面板里选哪些站要缓存。
> 6. 缓存要能**定时自动清理**（按天数 + 按容量），别把硬盘塞满。

---

## 2. 当前状态总览

```
✅ 美颜引擎         26 项效果、7 档预设、中文配方解析、XGPlayer/Plyr/B站/YouTube 适配（全站）
✅ 本地缓存服务     FastAPI，curl_cffi 传输，ffmpeg 合并
✅ v4 透明缓存      三家站点实测跑通（边看边存，零额外流量）
✅ 缓存按站开关     默认全关，用户在面板里自行开启某站，按域名记忆，可中途热切
✅ 缓存自动清理     保留 N 天 + 总容量上限，后台巡检，媒体库可手动立刻清
✅ 缓存手动删除     面板里「删除本视频 / 清空本站」，确认后立即释放磁盘
✅ 原站控制条       player-bar.js：在任意站点原视频上套自制控制条，按域名开关，不跳页
✅ 发丝分割         独立 hair-worker.js 跑 MediaPipe hair_segmenter，刘海/碎发不进磨皮
✅ 推理分辨率       裁切模式下 448–512 边长（原先被硬压到 384），脸在推理图里 168–252px
✅ 本地媒体库       GET / 列出已缓存视频（缩略图/进度/删除/清理规则），离线兜底用
⬜ 关键点预扫       未开始（原始设计文档的核心目标，见 7.4）
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
│   ① 域名开关过滤（rbCacheHosts，默认关）        │
│   ② 拦截 window.Hls 的赋值 → patch loadSource   │
│   ③ 把 m3u8 URL 改写成 127.0.0.1 本地代理       │
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

### 3.4 原站内嵌控制条（**主交互路径**）

不新开页面。`content/player-bar.js` 在目标站的**原页面里**给主 `<video>` 挂一层自己的控制条：

```
原站页面
├── <video>                ← 不动，仍是原站播放器在驱动
├── canvas.wvb-beauty-overlay   ← engine.js 的美颜层（z-index 2）
└── .rbp-root              ← 我们的控制条（z-index 2147483000）
      ├── 播放/暂停
      ├── 当前时间 / 进度条（可拖）
      ├── 总时长
      ├── 静音
      ├── 倍速 0.5~2x
      └── 全屏（请求容器全屏，保住美颜）
```

设计要点：

- **只操作 `<video>` 标准 API**（`play/pause/currentTime/volume/playbackRate`），所以 flowplayer / plyr / 自研播放器统统能接管 —— 它们最终都得落到这个元素上。
- 原站控制条按类名白名单隐藏（`.fp-controls` / `.plyr__controls` / `.xgplayer-controls` …），**只隐藏控制条行**，播放器外壳和点击层保留，不破坏原站交互。
- 全屏请求的是**容器**而不是 `<video>`：`engine.js` 在 `fullscreenElement === video` 时会主动 `hideCanvas()` 回退原生，美颜就没了。
- 同一份 `player-bar.js` 也被本地媒体库播放器页复用（`window.RBPlayerBar.attach(video)`）。

**开关（重点）**：`player-bar.js` 注入全站，但**是否挂载由用户决定**，配置存在 `chrome.storage.local` 的 `rbpPlayerBarHosts`，**按域名记忆**：

| 站点 | 默认 | 说明 |
|---|---|---|
| missav / javrate / avbebe | **开** | 自带播放器最简陋，直接接管 |
| 其它任意站点 | **关** | 用户想要就去面板里打开，只对该域名生效 |

开关位置：**美颜悬浮球 → 展开面板 → 「当前视频」卡片底部「播放器控制条 ⟷ <当前域名>」**。

API：`window.RBPlayerBar.setEnabled(bool)` / `isEnabled()` / `refresh()` / `ready`（Promise）。

改配置后**实时生效**，不用刷新页面。

### 3.5 缓存开关与自动清理（**2026-11-24 新增**）

#### 缓存不再是"全都存"，改成用户自己选

`grab-hook.js` **全站注入**，但默认**不改写任何 m3u8**。是否接管由用户的「本站缓存」开关决定，配置在 `chrome.storage.local` 的 `rbCacheHosts`：

```json
{ "missav.ws": true, "www.douyin.com": false }
```

- **没有条目的域名 = 不缓存**（默认全关，安全）
- 开关位置：美颜面板 →「当前视频」卡片 →「本站缓存 ⟷ <域名>」
- 面板下方会实时显示当前视频的缓存进度（`已缓存 130/374 片 · 35%`）
- 开关从关变开时，`grab-hook` 会把**正在播的 hls.js 实例热切**到本地代理（`reapplyLivePlayers`），保存 `currentTime` 与播放状态，**不用刷新页面**
- 唯一硬排除：B站 / YouTube（走 v2 的 `cache-hook.js`，不归这套管）

链路：`grab-relay.js`（ISOLATED，能读 chrome.storage）→ `sessionStorage` + `postMessage` → `grab-hook.js`（MAIN）读 `cacheEnabled`。

#### 自动清理

后台线程 `maintenance.CacheSweeper`，两条规则同时生效：

| 规则 | 默认 | 行为 |
|---|---|---|
| **保留天数** | 7 天 | `meta.lastAccessAt` 超过 7 天 → 删 |
| **容量上限** | 20 GB | 总量超限 → 按「最久没看」从旧到新删，直到降下来 |

- 巡检间隔 60 分钟，服务启动后延迟 45 秒跑第一次
- **删除一律走 `hls_cache.delete_video()`**（内含三层兜底），绝不直接 `rmtree`
- 巡检线程 `except BaseException` 全吞，清理失败不影响播放
- 媒体库页顶部显示规则与占用，带「立即清理」按钮
- `POST /api/maintenance/sweep?dry_run=true` 可以只看会删什么

用 `meta.lastAccessAt` 而不是目录 mtime 的原因：读分片会刷新 `lastAccessAt`，能真实反映"最近有没有看"；mtime 只在写文件时变。

#### 手动删除（**2026-11-24 新增**）

自动清理之外，用户随时能自己删。入口在美颜面板「当前视频」卡片、缓存进度下面同一行：

```
已缓存 130/374 片 · 35% · 70 MB
删除本视频 · 130 片          清空本站 · 1 条 · 70 MB
```

| 按钮 | 调用的接口 | 作用 |
|---|---|---|
| **删除本视频** | `DELETE /api/library/{key}` | 只删当前这条视频的整个缓存条目 |
| **清空本站** / **清空该站** | `DELETE /api/library?host=<site>` | 删该站点在本地的全部条目 |

- 两个按钮都要过 `confirm()`，文案里写明片数、体积、是否不可撤销
- **目标站点取自 `safeKey` 的前半段**（`avbebe.com_archives_357404` → `avbebe.com`），不是 `location.hostname`。本地播放器页的 host 是 `127.0.0.1`，直接拿 host 会删错目标；两者不一致时按钮文案自动变成「清空该站」
- 如果「本站缓存」开关还开着，视频会从当前位置重新缓存，确认框里会明确提示
- 在本地播放器页删当前视频会中断播放，确认框同样会提示

**请求路径**：面板先直连 `127.0.0.1:8765`（本地页同源；网页靠服务端的 CORS + `Access-Control-Allow-Private-Network` 头）。直连被浏览器拦下时，转 `chrome.runtime.sendMessage({type:"rb-cache-delete"})` 交给 service worker —— 它有 `host_permissions`，不受 CORS 约束。

删除动作全部落到 `hls_cache.delete_video()` 的三层兜底，**不会再出现把服务删崩的情况**。

---

## 4. 代码地图

### 4.1 扩展侧

| 文件 | 行数 | 职责 |
|---|---|---|
| `manifest.json` | 155 | MV3 配置。grab-hook 只注入三家站点；player-bar 全站注入（挂不挂载看开关） |
| `content/grab-hook.js` | ~330 | **v4 核心**。域名白名单 + hook `Hls.loadSource` + 原生 `video.src` |
| `content/player-bar.js` | ~500 | **原站内嵌控制条**。播放/进度/音量/倍速/全屏 + 按域名开关（`chrome.storage.local`） |
| `content/grab-relay.js` | 140 | ISOLATED world 桥接，把 pageKey / keys / serverOnline 同步给 MAIN |
| `background/grab-bridge.js` | 200 | 每 60 秒同步 `/api/keys`，提供 `rb-grab-init` |
| `content/engine.js` | 2700+ | 美颜渲染引擎（WebGL 26 项）。**同时被本地播放器页复用** |
| `content/overlay-ui.js` | 1600+ | 美颜悬浮面板。**同时被本地播放器页复用** |
| `worker/face-worker.js` | ~390 | MediaPipe 478 点检测（Web Worker）。**只能跑这一个任务** |
| `worker/hair-worker.js` | ~205 | MediaPipe 发丝分割（独立 Web Worker，781KB 模型） |
| `content/cache-hook.js` | — | v2 的 B站/YouTube hook（保留不动） |

### 4.2 服务侧

| 文件 | 行数 | 职责 |
|---|---|---|
| `cache-server/webui.py` | ~470 | **新增**。媒体库 + 播放器 + 本地 playlist + 静态资源 + 缩略图 |
| `cache-server/maintenance.py` | ~250 | **新增**。后台巡检：按天数和容量两条规则清理缓存 |
| `cache-server/hls_proxy.py` | ~570 | **v4 核心**。透明缓存全部逻辑 |
| `cache-server/server.py` | ~470 | FastAPI 路由（v2 + v3 + v4 + webui + maintenance 全挂在这） |
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

### 5.0 先明确：服务是**可选**的

美颜（`engine.js`）、原站控制条（`player-bar.js`）、B站/YouTube 的 v2 缓存，**全部不依赖本地服务**。
`cache-server` 只负责「把分片存到硬盘」+「媒体库页面」。

不启动服务时的降级路径（已在代码里确认）：

```
bridge 探测 GET /api/keys 失败  →  serverOnline = false
grab-hook.toLocalPlaylist()  →  if (!serverOnline) return mediaUrl   // 原样返回，不改写
```

结果：原站播放器行为与没装扩展完全一致，美颜与控制条照常工作。**只损失缓存与媒体库。**

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

### 6.6 两个会让「服务整条挂掉」的坑（2026-11-24 新增）

| # | 坑 | 说明 |
|---|---|---|
| 1 | **`shutil.rmtree` 会把整个 FastAPI 进程打死** | 在带文件安全垫片的环境里，`rmtree` 被重定向到回收站；删除文件数超过阈值（实测 50）时垫片直接 `raise SystemExit(1)`。`SystemExit` 继承自 **BaseException**，`except Exception` 接不住，FastAPI 也不接 —— 表现是 DELETE 请求 500、**进程当场退出**、所有页面全断。修法：`except BaseException` 兜住 → `SHFileOperationW` 永久删除 → 还不行就 `_move_aside()` 改名到 `_trash/`。三层都不影响进程存活 |
| 2 | **不要用 `cmd &` 挂后台进程** | `python main.py &` 在工具调用结束时会连同子进程一起被回收，表现为「刚才还好好的，下一秒 502」。要用工具的后台任务机制启动 |

验证记录：150 片目录删除 → `rmtree aborted by environment guard (SystemExit: 1)` → `force delete ok` → 服务全程存活，`/health` 一直 200。

### 6.7 缓存开关与清理的实测（2026-11-24）

```
缓存开关：
  默认（无配置）        cacheEnabled=false → toLocalPlaylist 原样返回，落盘 0 片
  面板开启后            正在播的 hls.js 热切到本地代理，进度保留，无需刷新
  配置持久化            chrome.storage.local 的 rbCacheHosts，按域名

自动清理：
  过期条目（10 天前）   dry-run planned=1 → 真清理 removed=[(oldtest-expired-entry, expired)]
  容量规则（上限 1MB）  69.8MB 条目 planned=1，reason=over-quota
  清理后服务            /health 仍 200，avbebe 缓存（最近访问过）未被误删
```

**注意**：测试时造过 `_oldtest_expired` 目录，因为 `_` 前缀被 `scan()` 当成 `_trash` 跳过，dry-run 显示 `planned: 0`，误以为清理没生效。写测试数据不要用 `_` 开头。

---

## 7. 未完成 / 下一步

### 7.1 域名白名单 → 已演进为「按站点开关」

最初用硬编码白名单（`ALLOW_HOST` 正则 + manifest matches 收窄）限制在三家站点。后来按用户要求改成**用户自己选**：

- `grab-hook` / `grab-relay` / `player-bar` 全部**全站注入**
- 是否接管由 `chrome.storage.local` 里的按域名开关决定
- 缓存（`rbCacheHosts`）**默认全关**，播放器控制条（`rbpPlayerBarHosts`）三站默认开
- 唯一硬排除仍然是 B站 / YouTube 的缓存（走 v2 的 `cache-hook.js`）

这样既不影响正规站（默认不动），又允许用户在任何站启用。

### 7.2 实时美颜的识别精度（已完成 2026-11-24）

起因：用户反馈"人脸识别不精确"、"刘海像被刷成一块白面具"。逐像素复现后定位到**三个互相独立**的原因，不是模型不行。

#### （1）刘海被当成皮肤一起磨 —— 已修：独立发丝分割

复现方法：把引擎的肤色判别函数搬到 Python，对用户提供的截图逐像素跑一遍。

| 区域 | luma | Cr | 肤色概率 | 最终美白权重 |
|---|---|---|---|---|
| 刘海区 | 0.23 | 0.511 | 0.04 | **0.18** |
| 左脸颊 | 0.54 | 0.559 | 1.00 | 1.00 |
| 下巴 | 0.31 | 0.586 | 1.00 | 1.00 |

结论反直觉：**刘海本身并没有被涂白**（只有 3% 的像素被判成皮肤）。真正的问题是刘海**缝隙里露出的一小条额头**是真皮肤，被整片磨平+提亮，把周围的发丝糊掉了，视觉上就成了"没有层次的白面具"。

靠调肤色阈值无解——那些像素确实是皮肤。必须引入语义分割。

方案：`hair_segmenter.tflite`（**781 KB**，256×256 输入，CPU 也只要几毫秒）。

**踩的坑（红线 20）**：MediaPipe 的 ES module WASM 在**一个 Worker 上下文里只允许 boot 一次 ModuleFactory**。把 `ImageSegmenter` 和 `FaceLandmarker` 塞进同一个 worker，第二次 `createFromOptions` 直接抛 `ModuleFactory not set`，且不可恢复。所以必须拆成 `worker/hair-worker.js` 独立跑。

链路：

```
face-worker  → 478 landmarks → maskCanvas → maskTex   (TEXTURE1)
hair-worker  → 256×256 matte → hairTex               (TEXTURE2)
                                    ↓
shader: skinArea *= 1 - hairConf * hairAmt
```

- 主线程每 `HAIR_EVERY=2` 次人脸推理发一帧给 hair worker；用 `createImageBitmap(inferCanvas, {resizeWidth:256,...})` 直接缩，不重新解码视频
- mask 是 Uint8 单通道，64 KB/帧，transfer 零拷贝
- 只覆盖人脸 ROI，用 `u_hairRect` 做 uv 映射

实测（1920×1080）：

| 指标 | 值 |
|---|---|
| hairWorker | 就绪 (GPU) |
| 分割耗时 | 11–14 ms（与主链路并行，不占渲染预算） |
| 覆盖率 `hairCoverage` | 0.04–0.15（随人脸大小变化，合理区间） |
| 渲染帧率 | **30 fps 不变** |

视觉验证（同一帧，`hairAmt` 0 vs 1）：**5.26% 的像素发生变化，且全部落在人脸/头发区域，画面其余部分零改动**。刘海从"模糊棕灰块"恢复成"一条条丝状纹理"，皮肤区域两版一致（证明遮罩没有溢出）。

#### （2）裁切模式把边长压回 384 —— 已修：448–512

这个是真 bug，而且是"做了优化但收益被抵消"的典型：

```js
// 改前
const targetEdge = roi.isSmallCrop ? Math.min(384, baseEdge) : baseEdge;
```

裁切窗口已经比全帧小了，`targetEdge` 又跟着压到 384，**缩放比相互抵消，脸的净像素数原地踏步**。所以"小脸 ROI 锁定"一直没真正生效。

同时门槛 `box.w < 0.26 || box.h < 0.36` 把**半身/近景（脸占 26%–45%）**挡在裁切外，这段全走全帧。

改后：

```js
if (box && (box.w < 0.45 || box.h < 0.55)) { ... cropA = faceSizeA * 2.8 ... }
const targetEdge = roi.isSmallCrop ? Math.max(448, Math.min(512, baseEdge)) : baseEdge;
```

- 门槛 26%/36% → **45%/55%**（脸太大时 `cropA` 被 clamp 到 0.95，`rw/rh < 0.88` 判断会自动退回全帧，不会强行放大）
- 倍率 3.1 → **2.8**（窗口更紧，脸占更多像素，仍留足运动余量）
- 下限 448：自适应逻辑会为保帧率把 `baseEdge` 压到 352，但裁切窗口本身很小，没必要跟着降

实测（1920×1080，同一个视频）：

| 脸在画面里 | 改前 facePx | 改后 facePx | 提升 |
|---|---|---|---|
| 高 35%（半身） | 101（全帧 512） | **168** | +66% |
| 高 53%（特写） | 153（全帧 512） | **252** | +65% |
| 宽 18%（远景） | 142（裁切 384） | **190** | +34% |

`facePxInfer` 是新增诊断字段（脸在推理图里的像素数）。landmark 模型输入 256，这个值到 180–250 就基本吃满原始细节；低于 100 说明放大的是插值不是像素。

帧率全程 **30/30**，`inferMs` 12–26 ms。

#### （3）GPU 冷启动阻塞首帧 —— 已修：预热 + 看门狗

hair worker 第一次 `segment()` 要编译着色器，实测阻塞 **2.5–3 秒**。这期间主线程的 `hairWorkerBusy` 被锁死，所有帧被挡，表现就是"刚打开视频那几秒刘海还是糊的"。

两处修复：

- **预热挪到 `postMessage(READY)` 之前**：用 `OffscreenCanvas` 画一张 256×256 灰图先跑一遍。主线程在 READY 之前不发帧，所以不会堆积过期帧。首帧可用时间 **2.5–3 s → 0.4 s**
- **6 秒看门狗**：worker 万一卡死（GPU 上下文丢失/未捕获异常），强制释放 `hairWorkerBusy`，否则整个生命周期都不再出遮罩

#### 还没做的

- **检测门槛 0.22 + `IMAGE` 模式逐帧独立检测**：低门槛换召回，代价是逐帧抖动、偶发误检。改成 `VIDEO` 模式加帧间跟踪能稳，但会和 ROI 切换互相污染（现有注释里写了这个取舍），要单独验证。
- **稳定器慢速运动时只走 52%–62% 新坐标**：这是"慢速转头遮罩慢半拍"的来源。可以按速度自适应 alpha，但会引入新的抖动风险。
- **磨皮仍是 12 tap 保边采样，不是严格的高低频频段分离**：纹理保留不可控。行业做法是导向滤波分离低频，输出 = 低频 + 0.35×高频。

### 7.3 本地媒体库 + 独立播放器页（已完成，定位为**离线兜底**）

> 注意：这是**兜底入口**，不是主交互路径。日常看片用 3.4 的原站内嵌控制条，
> 只有「原站打不开 / token 过期 / 想翻已缓存列表」时才用这个页面。

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

### 7.4 【核心目标】关键点预扫

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

### 7.5 其他待办

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

播放器控制条：

```js
window.RBPlayerBar.isEnabled()        // 当前域名是否启用
window.RBPlayerBar.getHost()          // 当前域名
window.RBPlayerBar.isDefaultOn()      // 是否属于默认开启的三站
window.RBPlayerBar.setEnabled(true)   // 手动开关（立刻挂载/卸载，不用刷新）
window.RBPlayerBar.ready              // Promise，boot 完成后 resolve
```

看/改配置（原生扩展页用 `chrome.storage.local`，本地播放器页是 shim 垫的 localStorage）：

```js
// 本地播放器页
JSON.parse(localStorage.getItem('rbp:rbpPlayerBarHosts'))
// 形如 {"missav.ws":true,"www.douyin.com":false}；没有条目就走默认值
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

# 自动清理
RB_CACHE_SWEEP=true             # 总开关
RB_CACHE_MAX_AGE_DAYS=7         # 超过这么多天没访问就删；0=不限
RB_CACHE_MAX_GB=20              # 总量上限 GB，超了按最久没看删；0=不限
RB_CACHE_SWEEP_INTERVAL_MIN=60  # 巡检间隔（分钟）
RB_CACHE_SWEEP_FIRST_DELAY=45   # 启动后多久跑第一次（秒）
```

前端开关（存 `chrome.storage.local`，不走环境变量）：

```
rbCacheHosts    { "missav.ws": true }   本站缓存，无条目=不缓存
rbpPlayerBarHosts { "missav.ws": true } 播放器控制条，无条目=三站默认开
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
11. **删缓存的代码必须 `except BaseException`** —— `shutil.rmtree` 可能被环境垫片用 `SystemExit` 中止，`except Exception` 接不住，整个服务会死
12. **控制条只能操作 `<video>` 标准 API** —— 不要碰具体播放器框架的内部状态；全屏要请求**容器**，请求 `<video>` 会让 engine 回退原生、美颜消失
13. **抖音 / B站 / YouTube 默认不要接管控制条** —— 用户明确要求保留它们自带的播放器。控制条改成「全站注入 + 按域名开关」，这些站默认关，用户自己开了才生效
14. **本地播放器页的脚本顺序：`hls.min.js → shim.js → player-bar.js → engine.js → overlay-ui.js`** —— `player-bar` 必须在 `shim` **之后**，否则它读配置时走无前缀 localStorage、写配置时走 shim 的 `rbp:` 前缀，读写键不一致，开关状态刷新就丢
15. **`grab-hook.js` 在 MAIN world，读不到 `chrome.storage`** —— 任何配置都必须由 `grab-relay.js`（ISOLATED）读好，再经 `sessionStorage` + `postMessage` 传进去。别在 hook 里直接调 chrome API
16. **自动清理只能走 `hls_cache.delete_video()`** —— 里面有三层兜底；自己写 `rmtree` 会重蹈「DELETE 打死服务」的覆辙
17. **缓存目录里 `_` 开头的目录不参与扫描** —— 那是删除失败时的 `_trash` 兜底位。写测试数据时别用 `_` 开头，否则会被当成 trash 跳过（踩过一次）
18. **「清空本站」的目标站点取自 `safeKey` 前缀，不是 `location.hostname`** —— 本地播放器页 host 是 `127.0.0.1`，用它当目标会删错条目（或一条都删不到）。两者不一致时按钮文案自动切成「清空该站」
19. **面板里的删除不要只写直连 fetch** —— 网页到 `127.0.0.1` 可能被 CORS / Private Network Access 拦，必须保留 `rb-cache-delete` 走 service worker 的兜底路径
20. **人脸和头发必须分两个 Worker** —— MediaPipe 的 ES module WASM 每个 Worker 上下文只允许 boot 一次 ModuleFactory。同一 worker 里第二次 `createFromOptions` 抛 `ModuleFactory not set` 且不可恢复。不要在 `face-worker.js` 里加第二个任务
21. **裁切 ROI 时不要把 `targetEdge` 压回 384** —— 窗口已经变小了，再压边长等于把省下的像素还回去，脸的净分辨率原地踏步。裁切走 448–512，并盯住 `facePxInfer` 这个诊断值
22. **新增 Worker 必须先在 `READY` 之前预热** —— GPU 首次推理要编译着色器（实测 2.5–3 秒）。放到 READY 之后会让主线程的 busy 标志锁死，表现为开头几秒效果不生效
23. **`hair_segmenter.tflite` 是二分类** —— `confidenceMasks[0]` 是背景，`[1]` 才是头发。取错类别会得到一张反的遮罩（头发被磨、皮肤被保护）

---

## 12. 参考文档

- `video-cache-spec-v3.md` —— v3 整片下载规格（第 0 节的实测数据仍有效）
- `video-cache-spec-v4.md` —— v4 透明缓存规格
- `realtime_beauty_cache_design.md` —— 关键点预扫的原始设计（第 2 节、4.4 节仍有效）
