# 交接任务书 · 关键点预扫（prescan）

> 写于 2026-11-24。给下一位接手的工程师（Gemini）看的**任务书**，不是项目文档。
> 项目全貌在 `HANDOVER.md`（767 行，先扫一遍第 3、6、11 节）。
> 本文只负责一件事：**把「关键点预扫」做完**，其余一律别动。

---

## 0. 一句话

视频已经落在本地硬盘上了。把**已缓存的那部分**离线跑一遍人脸关键点检测，存成按时间可查的表；
播放时实时检测没抓到脸的帧，**改用表里的坐标**，这样美颜就不会掉。

现状：实时链路的 `renderMode` 有 **约 35% 的帧是 `skin_fallback`**（90° 侧脸、运动模糊、遮挡等单帧检测的物理极限）。
这不是性能问题，加帧率、调阈值都救不回来 —— 只能靠离线补。所以这件事必须做。

---

## 1. 交付标准（先看这个，别写超出范围的代码）

**阶段 1（服务端，必须做完）**

1. 新建 `cache-server/prescan.py`：对一条已缓存视频做离线扫描，产出 `<entry>/landmarks.bin` + `<entry>/landmarks.json`。
2. 新建 `cache-server/prescan_api.py`：3 个 HTTP 接口（启动/查询/删除）+ 1 个静态下载接口，在 `server.py` 里挂上。
3. `config.py` 加 3 个环境变量；`meta.json` 里写 `prescan` 进度字段。
4. 能单跑：`python prescan.py <safeKey>` 直接扫一条，打印进度，产出文件。

**阶段 2（前端，接着做）**

5. `cache-server/web/player.html`：`loadedmetadata` 后拉 `/lm/{key}`，算时间轴映射，交给 engine。
6. `content/engine.js`：加查表兜底 —— worker 说「没脸」时先查表，查到了就照常渲染，不再淡出。

**验收**（第 9 节有可复制命令）

- 阶段 1：扫完一条，`check_landmarks.py` 打出的 `hasFace` 占比 ≥ 80%，文件体积符合第 7 节预算。
- 阶段 2：一条已扫过的视频连播 2 分钟，每 500ms 采一次 `getStateSnapshot().renderMode`，
  `face_mask` 占比 **≥ 90%**（改之前实测 65% 左右），帧率仍 30fps，`prescanHits > 0`。

---

## 2. 环境（照抄即可）

```powershell
# 项目根
E:\codex\2026-11-22\wo-x\work\web-video-beauty-mv3

# Python：项目自带 venv，3.13.15，已装 fastapi / uvicorn / curl_cffi / pydantic
cd E:\codex\2026-11-22\wo-x\work\web-video-beauty-mv3\cache-server
.\.venv\Scripts\python.exe -V

# 需要补装（已验证 3.13 有轮子：mediapipe 1.2.3 py3-none-win_amd64，25.7MB）
.\.venv\Scripts\python.exe -m pip install mediapipe numpy
# 国内慢就加： -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple

# 启动服务（前台调试用；别用 cmd & 挂后台，会被回收）
.\.venv\Scripts\python.exe main.py

# 健康检查：应含 "stage":"v4-transparent-hls"
curl http://127.0.0.1:8765/health
```

- `ffmpeg` 不用手动装，`config.FFMPEG_PATH` 会自己探测 winget / PATH / scoop。
- **模型文件现成的，别去下载**：`vendor/mediapipe/face_landmarker.task`（3.76MB），
  和网页端 `face-worker.js` 用的是同一个 `.task`，保证离线/在线结果同源。
- 现场有一条真实缓存可测：`~/Videos/grab-cache/avbebe.com_archives_357404/`，130 片 × 5s = 650s。
- 服务不跑也能测 prescan（纯命令行），但只要联调接口就得开着。

> **API 探路提醒**：mediapipe 1.2.x 的命名空间和 0.10.x 有差异。先跑 20 行 smoke test 确认
> `mediapipe.tasks.python.vision.FaceLandmarker` 存在；不存在就 `print(dir(mediapipe))` 探实际路径，
> 别硬着头皮按老教程写。`mediapipe.tasks` 这一层已确认存在。

---

## 3. 已经能跑的东西（一律别重做、别改）

| 能力 | 位置 | 状态 |
|---|---|---|
| v4 透明缓存（边看边存） | `hls_proxy.py` + `content/grab-hook.js` | 稳定 |
| 按站点开关缓存 | `rbCacheHosts`（chrome.storage.local） | 稳定 |
| 定时清理（7 天 / 20GB） | `maintenance.CacheSweeper` | 稳定 |
| 面板手动删（本视频 / 本站） | `overlay-ui.js` + `DELETE /api/library` | 稳定 |
| 原站内嵌控制条 | `content/player-bar.js` | 稳定 |
| 26 项美颜 + 发丝分割 | `content/engine.js` + `worker/*.js` | 稳定 |
| 本地媒体库 / 播放器页 | `webui.py` + `web/*.html` | 稳定 |

**已经替你排除掉的复杂度**（原始设计 `realtime_beauty_cache_design.md` 里的这些**全部不用做**）：

- ❌ 不用 hook MSE，不用解析 fMP4，不用 WebCodecs 解封装；
- ❌ 不用下载整片，不用 ffmpeg 合流；
- ❌ 不用碰 `/hls/*` 路由、playlist 生成、扩展的 `manifest.json`。

原因：视频已经以 TS 分片形式躺在磁盘上，直接用 ffmpeg 解码就行。
另外 `GET /l/{key}/index.m3u8?mode=cached`（只列已缓存分片）早就做完了，这是原设计的第 1 步。

---

## 4. 数据长什么样

```
~/Videos/grab-cache/<safeKey>/
  meta.json        key/mediaUrl/referer/segmentDuration/totalSegments/cachedCount/…
  segments.txt     分片原始 URL，一行一个，**行号 = 分片下标**
  segs/000000.ts   分片实体（纯 TS，首字节 0x47；MissAV 是伪装成 .jpeg 的纯 TS）
  segs/000013.ts   可能不连续 —— 用户没看到的部分没落盘
  v/0.m3u8         改写前抓到的原始 playlist 快照，含逐条 #EXTINF
  thumb.jpg        缩略图
```

真实样本（avbebe）：

```json
{"totalSegments": 374, "segmentDuration": 5.0, "cachedCount": 135}   // 磁盘实际 130 片
```

`cachedCount` 会虚高（增量累加，重试会重复计），**一切进度/片数以磁盘扫描为准**：
复用 `webui._scan_segs(entry) -> (indices, bytes)`、`webui._snapshot_durations(entry) -> [dur...]`、
`webui._ranges(indices) -> [[a,b],...]`，别自己再写一遍。

### 4.1 时间轴（最容易搞错的一处，务必读完）

- **整片时间轴**：第 k 片起点 = `sum(durations[:k])`。分片时长从 `v/0.m3u8` 的 `#EXTINF` 读，
  不要用 `k * 5.0` —— avbebe 是 5s，missav/javrate 是 4s，个别片还不是整数。
- **播放器时间轴会变**：`mode=cached` 的 playlist **跳过未缓存分片**，时间轴被压扁了。
  所以 `video.currentTime` 在 `mode=cached` 下**不等于**整片时间。
- 因此：`landmarks.bin` 里一律存**整片时间**；`landmarks.json` 额外给一张映射表，
  播放器页用它把 `currentTime` 换算成整片时间再查表。别图省事两边混用，会错位到不可调试。

---

## 5. 阶段 1 规格：`cache-server/prescan.py`

### 5.1 扫什么

**只扫已落盘的分片。** 未缓存的分片一律跳过，**绝不回源** —— 用户要的是「对已缓存内容做美颜」，
回源等于偷偷整片下载，而且 javrate 的 token 10–30 分钟就过期，根本拉不下来。

把已缓存下标折成连续区间（`_ranges`），一个区间跑一次 ffmpeg。

### 5.2 解码

```python
# 一个连续区间 -> 一个 concat 清单 -> rawvideo 管道
# 分片是纯 TS，直接拼接语义正确，不要做任何“剥头”处理
cmd = [FFMPEG_PATH, "-v", "error", "-f", "concat", "-safe", "0", "-i", list_txt,
       "-an", "-vf", f"fps={FPS}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
```

- `list_txt` 里写 `file 'E:\...\segs\000123.ts'` 绝对路径，`-safe 0` 必须加。
- 按 `W*H*3` 字节整块读 stdout，帧序即时间序。
- **帧时间戳**：`t_ms = runStartMs + i * (1000 / FPS)`，`runStartMs = sum(durations[:run[0]]) * 1000`。
  误差在半个采样间隔（≤125ms @4fps），可接受，不要为它去解析 PTS。
- 分辨率靠 `ffprobe -select_streams v:0 -show_entries stream=width,height` 拿一次；
  拿不到就用首帧字节数反推不现实 —— 直接报错退出，别猜。

### 5.3 检测

```python
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

opts = vision.FaceLandmarkerOptions(
    base_options=mp_python.BaseOptions(model_asset_path=str(MODEL)),  # vendor/mediapipe/face_landmarker.task
    running_mode=vision.RunningMode.IMAGE,   # 每帧独立，不跨帧漂移，正合“按时间点取值”
    num_faces=1,
    min_face_detection_confidence=0.30,      # 比实时(0.22)略高：离线宁可漏，不要假的
    min_face_presence_confidence=0.30,
    min_tracking_confidence=0.30,
)
landmarker = vision.FaceLandmarker.create_from_options(opts)
```

- 输入 `mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_uint8_hwc)`。
- 输出 `result.face_landmarks: list[list[NormalizedLandmark]]`，`x/y` 是 **0..1 整帧归一化**，
  和网页端 `face-worker.js` 的输出坐标系一致（那边也是 Float32Array(478*4) 的整帧 UV）。
- **主脸选择**：多张脸取 bbox 面积最大的。离线没有 ROI 上下文，别学 `selectPrimaryFace` 那套。
- **补检一次**：`face_landmarks` 为空时，把整帧放大 1.5 倍（中心裁 2/3）再 detece 一次，
  命中的坐标要换算回整帧。远端小脸靠这一步救回来，成本只在空帧上。
- 不做稳定器/滤波：`face-worker.js` 的 stabilizer 在 `paired` 模式下基本是直通，
  离线再滤会引入滞后，反而和我们想消除的掉妆是同类问题。

### 5.4 存哪些点（别存 478 个）

播放链路真正消费的下标是有限的（`engine.js` 的 `updateFaceMaskTexture` / `faceAnchors` 一共约 53–60 个），
存全量 = 每帧 1912B，纯浪费。**存一个固定的下标子集**，表写进文件头，engine 按表散射回 478 槽位。

`PRESCAN_POINTS` 常量（以 2026-11-24 的 engine.js 为准，可直接用）：

```
# face oval（36）
10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,
400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109
# 眼睛 8
33,133,159,145,263,362,386,374
# 桥/鼻/嘴/颊/颌/翼
168,1,13,14,61,291,361,129,358
```

以后 engine 新增消费下标 → **改这个常量并重扫**。（文件头带表，所以 engine 侧不需要同步常量。）

### 5.5 文件格式（`landmarks.bin`）

小端。头长 `headerLen = align4(24 + 2*nPoints)`，之后是定长记录，**O(1) 随机访问，不压缩**。

```
头：
  +0   magic    char[4]  "RBPS"
  +4   version  u16      = 1
  +6   fps      u16      采样帧率（整数）
  +8   count    u32      记录条数
  +12  nPoints  u16      每帧点数
  +14  scale    u16      定点缩放，= 10000
  +16  stride   u32      = 16 + 4*nPoints
  +20  reserved u32      = 0
  +24  idx[nPoints] u16  槽位 i 对应的 MediaPipe 关键点下标

记录（第 i 条，起点 headerLen + i*stride）：
  +0   t_ms   u32       整片时间轴毫秒
  +4   flags  u16       bit0 = hasFace
  +6   pad    u16       0
  +8   bbox   i16[4]    x,y,w,h × scale（归一化；hasFace=0 时全 0）
  +16  pts    i16[2P]   x0,y0,x1,y1… × scale
```

`landmarks.json`（同一目录，给映射和自检用）：

```json
{
  "version": 1, "fps": 4, "count": 2600, "nPoints": 60,
  "durationSec": 650.0, "binBytes": 665600,
  "points": [10, 338, "..."],
  "runs": [{"segStart": 0, "segEnd": 129, "tStartMs": 0, "tEndMs": 650000, "frames": 2600}],
  "scannedAt": "2026-11-24T12:00:00Z"
}
```

- 写盘顺序：`landmarks.bin.tmp` → `os.replace()`；json 最后写（json 存在 = 扫描完整）。
- `hasFace=1` 才写点；`hasFace=0` 时记录仍占满 stride（定长，别变长）。

### 5.6 进度与并发

- 进度写进 `meta.json` 的 `prescan` 字段（用 `hls_proxy._atomic_write_json`，别自己 open）：

```json
"prescan": {"state": "running|done|failed", "frames": 1200, "expected": 2600,
            "fps": 4, "error": null, "startedAt": "...", "updatedAt": "..."}
```

- **全局同时只允许 1 个扫描任务**（ffmpeg 解码吃满一个核，mediapipe 再吃一个；
  并发只会让播放卡）。用一个 module 级 `threading.Lock` + `set` 记录在跑的 key，第二个请求直接返回 409。
- 任务跑在 `threading.Thread(daemon=True)`，不要塞进 asyncio（ffmpeg 是阻塞 IO）。
- 每 200 帧刷一次 meta，别每帧写盘。
- 扫描期间**不要**阻止用户删缓存：`delete_video` 会整目录删，扫描线程遇到文件消失就
  干净退出（`state=failed, error="entry removed"`），不要抛异常打到 FastAPI。

### 5.7 接口（`cache-server/prescan_api.py`）

照 `webui.py` 的写法：模块级 `router = APIRouter()` + `bind(cache)`，
在 `server.py` 里 `prescan_api.bind(hls_cache)`、`app.include_router(prescan_api.router)`。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/prescan/{key}` | 返回 `meta.prescan` + 文件是否存在 + 体积；没有就 `{state:"none"}` |
| POST | `/api/prescan/{key}` | 起任务；已在跑 → 409；已 done → 200 直接返回现状（`?force=1` 重扫） |
| DELETE | `/api/prescan/{key}` | 删 `landmarks.bin/.json`，清 `meta.prescan` |
| GET | `/lm/{key}` | 返回 bin，`Content-Type: application/octet-stream`，加 `Cache-Control: no-store` |

- 路径参数用 `{key}`（safeKey 里有 `.`、`-`，别用 `{key:path}`，会把斜杠吃进去）。
- `GET /lm/{key}` 不存在就 404，**不要**现场触发扫描（前端会当加载失败处理）。
- 顺手在 `GET /api/library` 的列表项里加 `hasPrescan: bool`（`_library_item` 里加两行），
  媒体库卡片能显示「已预扫」，改起来最省事。

### 5.8 配置（`config.py` 追加）

```python
PRESCAN_FPS: int = int(os.environ.get("RB_PRESCAN_FPS", "4"))          # 采样帧率，8 更稳但耗时/体积翻倍
PRESCAN_MAX_FRAMES: int = int(os.environ.get("RB_PRESCAN_MAX_FRAMES", "400000"))  # 安全阀，超了自动降 fps
PRESCAN_AUTO: bool = os.environ.get("RB_PRESCAN_AUTO", "false").lower() == "true"  # 缓存满 N 片后自动扫
```

`RB_PRESCAN_AUTO` 先做成开关但**默认关**，等阶段 2 验收通过再考虑默认开。

---

## 6. 阶段 2 规格：播放时查表

目标：**改动尽量小**。不要重写检测链路，只在「worker 说没脸」的那一刻插一刀。

### 6.1 `player.html`

```js
// boot() 里，拿到 info 之后
window.__RB_FULL_TIME_MAP__ = buildTimeMap(info.ranges, info.durations);  // 见下

// loadedmetadata 之后（enableBeauty 附近）
fetch(`/lm/${encodeURIComponent(KEY)}`, {cache:"no-store"})
  .then(r => r.ok ? r.arrayBuffer() : null)
  .then(buf => { if (buf) window.__WVB_ENGINE__.setPrescan(buf, window.__RB_FULL_TIME_MAP__); })
  .catch(() => {});
```

`buildTimeMap(ranges, durations)`：把「播放器时间轴 → 整片时间轴」的换算做成一组分段线性段。
`ranges` 是闭区间分片下标数组（`/api/library/{key}/segments` 已经返回），
每段：`plStart = 前面所有段时长之和`，`fullStart = sum(durations[:segStart])`。
`mode=all` 时整片连续，直接返回 `null`（恒等映射）。

### 6.2 `engine.js`（改动点已定位）

| 位置 | 改动 |
|---|---|
| 构造函数（`this.latestLandmarks = null;` 附近，约 L728） | 加 `this.prescan = null; this.prescanHits = 0; this.prescanMiss = 0;` |
| 新增方法 | `setPrescan(buffer, timeMap)`：解析头，保存 `DataView` / `stride` / `fps` / `count` / `idx` / `headerLen` / `timeMap`；解析失败就 `this.prescan = null` 并 warn，**绝不抛** |
| 新增方法 | `lookupPrescan(fullSec)`：`i = round(fullSec * fps)`，越界或 `flags&1 === 0` 返回 null；否则按 `idx` 散射出 `Float32Array(478*4)`（`vx=vy=0`），顺便返回 bbox |
| `RESULT` 的 else 分支（约 L1767，现在会 `missStreak++` 并淡出） | **先查表**：命中就 `this.latestLandmarks = lm; this.lastFaceBox = box; this.missStreak = 0; this.fadeWeight = 1.0; this.prescanHits++`，然后 `return` 走原有渲染；没命中才执行原来的淡出逻辑，并 `prescanMiss++` |
| `updateFaceMaskTexture`（L2272） | **一行不改**。它只吃 `this.latestLandmarks`，散射出来的数组天然兼容 |
| `getStateSnapshot()` | 加 `prescan: {ready, hits, miss, fps, count}`，验收要用 |

- 坐标：整帧 UV，`Float32Array(478*4)`，布局 `x,y,vx,vy`，与 worker 输出完全一致。
- `timeMap` 为空（`mode=all`）时直接用 `video.currentTime`。
- **不要把查表结果写回 worker、不要让 worker 跳过检测** —— 实时链路是主路，表只是兜底。
  这样即使 prescan 数据有问题，最坏也就是回到今天的状态。
- 扩展（`content/engine.js` 在普通网页里跑）没有 prescan 数据，`setPrescan` 永不被调用，
  `this.prescan === null` 时所有分支必须保持今天的行为 —— 这是硬要求，别让线上扩展退化。

---

## 7. 体积与耗时预算

单帧记录 = `16 + 4*60 = 256` 字节。mediapipe CPU 单帧约 20–30ms（含解码分摊会更高一点）。

| 视频 | FPS | 记录数 | bin 体积 | 扫描耗时（估） |
|---|---|---|---|---|
| 650s（现场样本） | 4 | 2 600 | 0.65 MB | 1–2 min |
| 1 小时 | 4 | 14 400 | 3.6 MB | 6–8 min |
| 4 小时 | 4 | 57 600 | 14 MB | 25–35 min |
| 4 小时 | 8 | 115 200 | 29 MB | 50–70 min |

- 默认 4fps。**4fps 的空档由实时链路覆盖**，只有实时也失败的帧才用到表，所以不需要 30fps 级别的表。
- 阶段 3（可选，别现在做）：查表命中时对相邻两帧做线性插值，把 250ms 空档抹平。
- `landmarks.bin` 会算进缓存条目的体积（`_scan_segs` 只扫 `segs/`，所以默认不计入；
  但 `maintenance` 的容量统计如果按目录总大小算，就会算进去 —— 实现时确认一下，别让 14MB 的表把视频挤掉）。
- 删视频（`delete_video` 整目录删）会自动带走 `landmarks.*`，**不需要额外改清理逻辑**。

---

## 8. 红线（本次新增，和 `HANDOVER.md` 第 11 节的 23 条并列）

1. **不要扫未缓存分片、不要为一个没落盘的片去请求原站。** 用户的原始需求就是「只对已缓存内容」；
   触发回源 = 偷偷整片下载，且 javrate token 会过期。
2. **不要在 `face-worker.js` 里加第二个 MediaPipe 任务。** 一个 Worker 上下文只能 boot 一次
   ModuleFactory，第二次 `createFromOptions` 抛 `ModuleFactory not set` 且不可恢复（HANDOVER 红线 20）。
   prescan 在 Python 侧跑，跟它无关 —— 别顺手去改 worker。
3. **不要用 `shutil.rmtree` 删任何缓存相关的东西。** 环境垫片会用 `SystemExit` 中止，
   `except Exception` 接不住，整个 FastAPI 进程当场退出。删就用 `hls_cache.delete_video()`
   （HANDOVER 红线 11）。
4. **不要动 `/hls/*`、`/l/{key}/index.m3u8`、`grab-hook.js`、`manifest.json`。** 缓存链路是好的，
   改它只会把「能看」变成「不能看」。
5. **不要把 `video.currentTime` 当整片时间用。** `mode=cached` 的时间轴是压缩过的（4.1 节）。
6. **不要给分片「剥伪装头」。** MissAV 的 `.jpeg` 分片是纯 TS（628484 ÷ 188 整除，首字节 0x47），
   剥了必花屏（HANDOVER 红线 1）。
7. **不要 push 到 GitHub。** 本地 commit 就行，仓库一直没推过远端。
8. **不要动那 26 项美颜参数、不要动 shim 的 `getURL`、不要改播放器页的脚本顺序。**
   这三处都是踩过坑才对的，改了就静默退化（HANDOVER 红线 9、14）。

---

## 9. 验收命令

```powershell
cd E:\codex\2026-11-22\wo-x\work\web-video-beauty-mv3\cache-server

# ① 单跑扫描（阶段 1 自测，不用开服务）
.\.venv\Scripts\python.exe prescan.py avbebe.com_archives_357404
#   期望：进度条走完，打印 frames / hasFace 占比 / bin 体积

# ② 文件落地
dir $env:USERPROFILE\Videos\grab-cache\avbebe.com_archives_357404\landmarks.*

# ③ 自检脚本（建议顺手写 scripts\check_landmarks.py）
.\.venv\Scripts\python.exe ..\scripts\check_landmarks.py `
  $env:USERPROFILE\Videos\grab-cache\avbebe.com_archives_357404\landmarks.bin
#   期望：magic=RBPS、fps=4、nPoints=60、count≈2600、
#         随机抽 20 帧打印 t_ms + bbox + 前 3 个点，hasFace 占比 ≥ 80%

# ④ 接口
curl http://127.0.0.1:8765/api/prescan/avbebe.com_archives_357404
curl -X POST http://127.0.0.1:8765/api/prescan/avbebe.com_archives_357404
curl -o NUL -w "%{size_download}\n" http://127.0.0.1:8765/lm/avbebe.com_archives_357404

# ⑤ 浏览器（阶段 2）
#   打开 http://127.0.0.1:8765/play/avbebe.com_archives_357404
#   控制台：
#     window.__WVB_ENGINE__.getStateSnapshot().prescan   // {ready:true, count:2600, ...}
#     // 采样 4 分钟，统计 face_mask 占比
#     let n=0,f=0; const t=setInterval(()=>{const m=window.__WVB_ENGINE__.getStateSnapshot().renderMode;n++;if(m==='face_mask')f++;},500);
#     setTimeout(()=>{clearInterval(t);console.log('face_mask',(f/n*100).toFixed(1)+'%',f+'/'+n)},240000)
#   期望：≥ 90%（改前 65% 左右），diagnostics.renderFps 仍 ≈ 30
```

**客观验证法**（比肉眼看可靠）：同一时间点截两次 canvas，
一次让 `prescan` 生效、一次把 `this.prescan = null` 强制关掉，numpy 比 diff —— 差异必须只落在人脸区域。
这个方法是之前验证发丝分割用的，同样的套路。

---

## 10. 明确「不要做」的清单

- ❌ 不做整片 mp4 合并 / 导出（v3 那套已随代码删除，别复活）
- ❌ 不改缓存策略、不改清理规则、不加自动全站缓存
- ❌ 不重写检测链路、不动 26 项参数、不调 `face-worker.js` 的门槛
- ❌ 不引入 numpy 以外的新依赖（opencv / torch / onnxruntime 一律不要）
- ❌ 不做「预扫时顺便把未缓存分片拉下来」——见红线 1
- ❌ 不为了让数字好看去改验收口径（`skin_fallback` 不是错误，是小脸/侧脸的正常降级）

---

## 11. 已知会咬人的点

| 现象 | 真因 | 处置 |
|---|---|---|
| `hasFace` 占比低（<60%） | 全帧 256 输入对远端小脸不够 | 5.3 的「空帧放大 1.5 倍补检」；仍不行就确认 `min_face_detection_confidence` 没被写成 0.5+ |
| 查表命中但画面抖 | `t_ms` 与 `currentTime` 时间轴不一致 | 回到 4.1，检查 `timeMap`；八成是 `mode=cached` 下直接用了 `currentTime` |
| 扫到一半文件没了 | 用户点了删除 / 自动清理 | 捕获 `FileNotFoundError`，`state=failed`，别让线程抛 |
| ffmpeg 报 concat 失败 | 清单里路径没加 `-safe 0` 或用了相对路径 | 绝对路径 + `-safe 0` |
| mediapipe 装完 import 就崩 | 1.2.x 与 0.10.x 命名空间不同 | 先 smoke test，再写主逻辑 |
| 播放帧率掉到 25 以下 | 扫描线程和播放抢 CPU | 确认「全局 1 个任务」；扫描时把 `ffmpeg` 加 `-threads 2` |
| `meta.prescan` 一直是 running | 线程死了没人改状态 | 服务启动时把所有 `running` 重置为 `failed`（加在 lifespan 里，5 行） |

---

## 12. 收尾要求

1. 阶段 1 做完先 **commit 一次**（message 写清 `feat(prescan): offline landmark scan + /lm API`），
   阶段 2 再 commit 一次。**不要 push。**
2. 改完在 `HANDOVER.md` 的「7.4 关键点预扫」下补一段「已完成」+ 实测数字（hasFace 占比、
   face_mask 占比改前/改后、bin 体积、扫描耗时），并把第 2 节总览表的 `⬜ 关键点预扫` 改成 `✅`。
3. 若中途发现设计有问题（比如 Python mediapipe 精度确实不够），**停下来写清结论**再决定，
   不要一路改到「能跑但不知道为什么能跑」。
