# 字幕翻译交接 · 日语 / 英语 → 简体中文

更新于 2026-11-25。字幕功能和自动选档已提交到本地 `main`（`56faaf1`）。项目整体背景见 [主交接文档](HANDOVER.md)。

## 现在能用什么

- 面板里的「本地字幕」按域名记忆，默认关闭，可选中文字幕或双语字幕。本地播放器通过存储垫片保存设置。
- Whisper `small` 用 CPU 转写，混元 `Hy-MT2 1.8B Q4` 在本机翻译。模型预先准备后，转写和翻译只需本机服务。
- 播放时只处理落盘的连续 TS 区间，以播放头前约 30 秒为处理目标。首块约 10 秒，后续块约 20 秒，按分片长度对齐，并保留约 1.2 秒的边缘语音上下文。
- 跳播时优先处理新位置，远跳可以取消旧位置的推理。生成好的原文和译文随视频缓存保存，回看、重启以及切换性能档位都可以复用。

## 启动与选档

基础服务启动方式沿用 [README](README.md#离线中文字幕可选)。在 `cache-server` 的 Python 环境中准备字幕依赖和模型：

```powershell
python -m pip install -r requirements-subtitles.txt
python -c "from huggingface_hub import snapshot_download; print(snapshot_download('Systran/faster-whisper-small'))"
$env:RB_SUBS_LLAMA_BIN = 'C:\tools\llama.cpp\llama-server.exe'
$env:RB_SUBS_MT_MODEL = 'C:\models\Hy-MT2-1.8B-Q4_K_M.gguf'
python main.py
```

把示例路径换成本机路径。可用 `RB_SUBS_WHISPER_DIR` 指定已下载的 Whisper 目录。

**硬件自适应分级与两级休眠（2026-11-25 新增）**：
- **取消 4 核硬限制，按硬件自动分级**：
  - 高配档（≥18 GB 内存且 ≥12 逻辑核）：Whisper 自动用 `min(10, 逻辑核/2)` 线程、`beam_size=2`，开启双模型热复用（闲置 3 分钟自动卸载，即一级休眠）。
  - 均衡档（≥11 GB 且 ≥8 逻辑核）：Whisper 用 `min(6, 逻辑核-2)` 线程、`beam_size=2`，热复用闲置 90 秒释放。
  - 低配档（如 8 GB / ≤6 核）：Whisper 用 `min(4, 核-1)` 线程、`beam_size=1`，不常驻热模型（用完即杀），串行释放以防爆内存。
- **实时内存安全阀**：运行中若系统实时可用内存低于阈值（默认 3.5 GB），自动降级为串行“用完即杀”并卸掉热模型。
- **测速结果持久化**：按 CPU/GPU/模型指纹缓存在 `cache-server/native-host/profile-cache.json`，结合 Native Messaging 30 分钟空闲自关（二级休眠），下次唤醒可直接复用最优档位，无需重复测速。
- 可通过 `RB_SUBS_THREADS`、`RB_SUBS_BEAM_SIZE`、`RB_SUBS_WARM_TTL_SEC` 手动覆盖默认策略。

「字幕性能」默认自动，也可以手动选 **CPU 兼容、CPU 多核、GPU 翻译**。自动档先用 CPU 产出字幕。在播放优先队列空闲后，用同一组固定短句比较可用翻译档位。高/中配启用热复用时测速包含 1 句预热后计时以反映连续播放时的热态速度；低配仍计入冷启动耗时。候选的耗时比 CPU 兼容档至少低 8% 才自动切换，跳播或当前字幕待生成时会收回短测。面板显示实际生效的档位，手动偏好经 `rbSubsProfile` 保存。

CPU 多核会给混元分配更多 CPU 线程。GPU 翻译使用已安装的 Vulkan 版 `llama-server`，可通过 `RB_SUBS_LLAMA_GPU_BIN` 配置。手动选 GPU 时，缺少可用后端、显存不足或 GPU 档运行失败会回退到 CPU 兼容档。三个档位的 Whisper 转写都在 CPU 上执行。

## 代码、接口和缓存格式

| 入口 | 负责什么 |
|---|---|
| `cache-server/subtitles.py` | 单个后台工作线程、播放头和跳播优先级、分片范围、字幕落盘 |
| `cache-server/subtitle_inference.py` | FFmpeg 只解码本地分片，向 Whisper 传入 16 kHz 单声道 PCM 转成的 float32 数组，管理本机混元进程 |
| `cache-server/subtitle_profiles.py` | CPU 核数、内存和 Vulkan 可用性检测，短测计时、选档及回退 |
| `cache-server/subtitle_api.py` | `GET /api/subs/{key}?time=60` 读取附近字幕和状态，`POST /api/subs/{key}/focus` 更新播放位置和优先级 |
| `content/subtitles.js` | 原站和本地播放器共用的字幕显示。本地仅缓存播放复用 `window.__RB_FULL_TIME_MAP__`，原站经 `background/grab-bridge.js` 访问本机服务 |

`focus` 请求包含 `session`、`time`、`seek`、`active`，可带 `until` 和 `profile`。响应的 `profile` 对象提供 `requested`、`effective`、`available`、`timings`，计时单位为秒。只查状态时用 GET，读取接口不会启动转写。视频位置未缓存或字幕暂未生成时，播放器会提示当前状态。

缓存条目中的 `subs.src.jsonl` 和 `subs.zh.jsonl` 都按块追加，每行包含分片编号闭区间和对应的原文或译文。译文按 cue ID 对齐，静音块也记录完成范围。所有 cue 时间都在整片时间轴上，按已完成范围续处理，后来补进来的分片也能单独生成字幕。

## 实测与待验收

| 项目 | 已测结果 |
|---|---|
| 日语稀疏缓存 | 用日语分片验证了生成、远跳优先和回跳复用。调度回归测试覆盖取消旧任务、后续补片和重启复用 |
| 两小时实片 | 英语片《Meet John Doe》全长 2:02:51，1,475 个已缓存分片。按需试播和跳播覆盖片头、中段、两小时处 |
| 新位置出字幕 | 三处已缓存、未生成的跳播位置约 12.4–13.1 秒出首批中文。另一处连续播放约 42 秒的测试中，约 8.4 秒首次显示中文，共生成 8 条 |
| 回跳复用 | 回到已生成处，约 0.1 秒重新显示 |
| 自动选档 | 一次 4060 机器上的固定短句冷启动测试，CPU 兼容 5.55 秒、CPU 多核 5.06 秒、GPU 翻译 15.91 秒，自动选 CPU 多核。手动 GPU 也用本地日语分片生成了中文字幕 |

待验收项包括原站网页实际播放、8 GB 无独显实机长时间运行，以及日语口语和低清晰度音轨的字幕质量。连续预览时有些字幕仍晚于播放头。长片记录来自按需试播和跳播，覆盖范围以测试位置附近为准。

---

<details>
<summary>初始任务书（历史记录）</summary>


# 交接任务书 · 字幕翻译（日/英 → 中）

> 写于 2026-11-25。和 `HANDOVER-PRESCAN.md` 同一套格式：这是**任务书**，不是项目文档。
> 项目全貌看 `HANDOVER.md`；预扫已完成（`f0421c9` / `aa80c31`），本文照它的骨架做第二件事。
> 本文只负责一件事：**让缓存的片子能出中文字幕**。

---

## 0. 一句话

音频已经在硬盘上了（TS 分片里就是 AAC）。**离线**把它转成文字、翻成中文，存在片库里；
播放时按时间轴把当前这句叠在画面上。

**不要做实时推理。** 字幕只需要比播放头**超前 30 秒**，不需要压到几十毫秒。
这是它比美颜简单一个数量级的根本原因 —— 美颜每帧都要 33ms 出结果，字幕 30 秒的预算。

---

## 1. 交付标准

| 阶段 | 内容 | 验收 |
|---|---|---|
| **1** | `cache-server/subs.py`：增量抽音频 → ASR → `subs.src.jsonl` | 命令行跑一条，打出 100 句带时间戳的日文 |
| **2** | `cache-server/subs_api.py`：4 个路由 + `subs.zh.jsonl` 翻译队列 | `curl` 能拿到 cues；进度可见 |
| **3** | `content/subtitles.js` + 面板开关：原站和本地播放器页都能显示 | 播放时字幕跟着出现，双语/单语可切 |
| **4** | 翻译后端（云端或本地，见第 6 节） | 中文可读，不是机翻腔 |

阶段 1–3 跑通就能用（只有日文/英文字幕），阶段 4 是把它变成中文。**按这个顺序做，不要跳。**

---

## 2. 环境

```powershell
cd E:\codex\2026-11-22\wo-x\work\web-video-beauty-mv3\cache-server
.\.venv\Scripts\python.exe -V        # 3.13.15

# 已装（2026-11-25 由本项目装入）
#   faster-whisper 1.2.1 / ctranslate2 4.9.1 / onnxruntime / av 19.0.2 / numpy
# 云端路线额外需要：openai（或直接 curl / httpx，服务器已有 httpx）
.\.venv\Scripts\python.exe -m pip install openai
```

**已知坑（实测）**：`faster-whisper 1.2.1` + `av 19.0.2` 不兼容 —— `transcribe(path)` 内部调
`av.open(..., metadata_errors=...)`，而 av 19 删了这个参数，直接 `TypeError`。
**必须自己读 wav 成 float32 数组再喂进去**，绕开它的解码路径。可用代码见 `scripts/probe_asr.py`。

模型缓存：`HF_ENDPOINT=https://hf-mirror.com`（国内直连 HF 会卡）。

---

## 3. 现状：可以照抄的东西

预扫已经把「离线处理已缓存分片」这件事做完了，翻译几乎是同一个形状：

| 预扫（已完成，直接读代码） | 翻译对应物 |
|---|---|
| `cache-server/prescan.py` | `cache-server/subs.py` |
| `landmarks.bin` + `landmarks.json` | `subs.src.jsonl` + `subs.zh.jsonl` |
| `prescan_api.py`：`GET/POST/DELETE /api/prescan/{key}` + `GET /lm/{key}` | `subs_api.py`：同样四个，路径换 `subs` |
| `meta.json` 里的 `prescan` 进度字段 | `meta.json` 里的 `subs` 字段 |
| `player.html` 的 `buildTimeMap()` + `window.__RB_FULL_TIME_MAP__` | **原样复用**，见 4.2 |
| `engine.js` 的 `mapPlayerToFullTime()` | 字幕层写一个同样的，或直接抽成公共函数 |

**不要重新发明时间轴映射**，那一块预扫已经踩完坑了。

---

## 4. 数据与时间轴

### 4.1 音频从哪来

只从 `segs/*.ts` 里抽，**已缓存多少处理多少，绝不回源**（和预扫红线 1 一致）。

```python
# 一个连续区间 → 一个 concat 清单 → 16k 单声道 wav
[FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list_txt,
 "-vn", "-ac", "1", "-ar", "16000", str(wav)]
```

实测：60 片（300s）→ 9.6MB wav，耗时 1.6 秒。

- 分片是纯 TS，直接拼接语义正确，**不要剥头**（HANDOVER 红线 1）。
- 抽完立刻删 wav（4 小时片子是 460MB），别留在缓存目录里被算进体积。
- 只抽**新增**的分片：记住 `processedUntilSeg`，从下一片开始拼，不要每次重抽全片。

### 4.2 时间轴（沿用预扫的结论）

- ASR 输出的时间戳是**整片时间轴**（`t = sum(durations[:segStart]) + 段内偏移`）。
- `mode=cached` 的播放器时间轴是**压缩过的**，必须用 `buildTimeMap()` 映射后再查。
- 原站播放不受影响：`grab-hook` 改写的是 master，分片按需回源，`currentTime` 就是整片时间。

### 4.3 文件格式

**两个文件，都是 append-only**（增量写入，永远不重写整个文件）：

`subs.src.jsonl`

```jsonl
{"v":1,"key":"avbebe.com_archives_357404","lang":"ja","langProb":0.98,"engine":"faster-whisper:small","createdAt":"2026-11-25T03:00:00Z"}
{"id":0,"t0":1.62,"t1":5.32,"src":"短くなおその馴染みと興味本位でやってみたら","nsp":0.45}
{"id":1,"t0":5.62,"t1":7.10,"src":"そうだった","nsp":0.45}
```

`subs.zh.jsonl`（翻译结果，按 `id` 对齐，允许乱序、允许缺失）

```jsonl
{"id":0,"zh":"变得越来越短，抱着好奇试了一下"}
{"id":1,"zh":"原来是这样"}
```

- 第一行是 meta，只写一次；之后每行一条 cue。
- `id` 自增，**断点续传靠最后一条的 `id` 和 `t1`**。
- 时间单位**秒，保留两位小数**（不要毫秒整数，前端算起来别扭）。
- 写盘：`flush()` + `os.fsync()` 每 20 条一次；进程被杀最多丢 20 句，不要一行一刷。

### 4.4 语种检测（日/英）

需求是**日语和英语都要转中文**。`language=None` 让 whisper 自己判，但有个坑：

> Whisper 的语种识别**只看开头 30 秒**。这类片子开头常是厂牌 logo、纯 BGM 或静场，
> 会把日语误判成英语（音素重叠），然后整条片子按英语翻，全毁。

做法：**投票**。取前 3 个 VAD 检出的语音区间，各自跑一次检测，取多数；置信度 < 0.6 就记为 `"lang":"auto"`，
让翻译时由模型自己判断。

```python
segments, info = model.transcribe(audio, language=None, vad_filter=True, ...)
# info.language / info.language_probability
```

---

## 5. 阶段 1–3 规格

### 5.1 `cache-server/subs.py`

```python
def collect_runs(entry) -> list[tuple[int, int]]:   # 复用 webui._ranges(_scan_segs(entry)[0])
def ensure_audio(entry, run, processed_until) -> Path   # 只拼新增分片
def transcribe(wav, lang=None) -> tuple[list[dict], str, float]  # cues, lang, prob
def append_cues(entry, cues) -> int                 # 返回新 id
def run(safe_key) -> None                           # 主循环，可被 API 复用
```

- 状态写 `meta.json` 的 `subs` 字段（用 `hls_proxy._atomic_write_json`）：
  `{"state":"running|done|paused|failed","cues":120,"lang":"ja","processedUntilSeg":129,"error":null,"updatedAt":"..."}`
- 线程模型和 `prescan.py` 完全一致：`threading.Thread(daemon=True)`，全局只允许 1 个任务，第二个请求 409。
- 视频被删（`delete_video` 整目录删）→ 线程捕获 `FileNotFoundError` 干净退出，`state=failed`，不要抛到 FastAPI。
- 主循环每处理完一个区间就检查一次「播放器是否在播」，在播就 `time.sleep()` 让出 CPU（见 5.3）。

### 5.2 `cache-server/subs_api.py`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/subs/{key}` | 进度：`{state, cues, lang, totalSec, coveredSec}` |
| POST | `/api/subs/{key}` | 起任务；`?force=1` 重扫 |
| DELETE | `/api/subs/{key}` | 删 `subs.*.jsonl`，清 `meta.subs` |
| GET | `/subs/{key}` | 返回 `{"meta":{...},"cues":[{id,t0,t1,src,zh}]}`，前端一次拿全 |
| POST | `/api/subs/{key}/throttle` | `{"playing":true}` 让后台让出 CPU，见 5.3 |

`subs_api.bind(hls_cache)` + `app.include_router(...)`，照 `prescan_api.py` 抄。
`GET /subs/{key}` 合并两个 jsonl 后返回；文件不存在返回 404，**不要现场触发扫描**。

### 5.3 空闲调度（这条决定「用起来烦不烦」）

4 小时片子边看边转，CPU 满载一两小时 → 风扇狂转。所以：

```
前端 video 'play'  → POST /api/subs/{key}/throttle {"playing":true}
前端 video 'pause' / pagehide → {"playing":false}
服务端 playing=true  → 线程 sleep，或 cpu_threads 降到 2
服务端 playing=false → 恢复
```

不用精确，几十秒的滞后无所谓 —— 只要超前播放头 30 秒就够。

### 5.4 `content/subtitles.js`（前端）

- 找主 `<video>`（复用 `player-bar.js` 里挑主视频的逻辑），叠一个 `pointer-events:none` 的容器。
- 用 `requestVideoFrameCallback` 或 `timeupdate` 取 `currentTime`，**二分查**当前 cue（cue 数组按 `t0` 排序）。
- 原站：`currentTime` 直接是整片时间。
  本地播放器页：先过 `buildTimeMap()`（`window.__RB_FULL_TIME_MAP__`）。
- 拿 key：原站用 `window.__RB_HLS_DEBUG__.getSafeKey()`（已存在）；本地页用 `window.__RB_LOCAL_KEY__`。
- 样式照沉浸式翻译：**底部居中，原文一行小字、译文一行大字**，可调字号/背景不透明度/位置。
- 播放头跑过最后一条 cue 时，最多每 10 秒提示一次「字幕生成中」，**绝不提前塞后面的话**（错位比没有更难受）。
- 开关：面板加一行「字幕 ⟷ <域名>」，存 `chrome.storage.local` 的 `rbSubsHosts`，**默认全关**，
  和 `rbCacheHosts` / `rbpPlayerBarHosts` 一个模式。本地播放器页走 `shim` 的 localStorage。
- `manifest.json` 加一组 content_scripts：`subtitles.js` 全站注入（和 `player-bar.js` 并列），
  是否需要 `player-bar.js` 的容器判断逻辑 → 直接复用，别写第二套。

---

## 6. 阶段 4：翻译后端（两条路，二选一）

抽象成一个函数，两个实现都符合：

```python
def translate(cues: list[dict], lang: str, context: list[str]) -> dict[int, str]
```

### 6.1 云端（省事，建议先跑通体验）

| 项 | 值 |
|---|---|
| ASR | `POST /v1/audio/transcriptions`，`model=whisper-1`，`response_format=verbose_json`（**要 segments 才有时间戳**） |
| 翻译 | `gpt-4o-mini`，一批 20 条，JSON 进 JSON 出 |
| 成本 | 转写 $0.006/分钟 → 1 小时约 ¥2.6；翻译约 ¥0.15 |
| 代码量 | 比本地少一半（没有模型管理、显存调度） |

**风险（必须写进 README 让用户知道）**：这类台词会被内容策略处理 —— 可能返回被「净化」的版本
（脏话消失、露骨词换成中性词），可能 400 拒绝。用户看不出被改过，这是最坑的一点。

### 6.2 本地（免费、不联网、无审查，终态）

| 件 | 选型 | 体积 |
|---|---|---|
| ASR | `faster-whisper` medium（CPU int8，6 线程） | 约 1.5GB |
| 翻译 | Qwen2.5-7B-Instruct Q4（ollama 或 llama.cpp） | 约 4.7GB |

- 实测：small 在 i7-13650HX 上 **4.6× 实时**；medium 约 2.5×；large-v3 上 GPU 20–40×。
- 显存红线：4060 只有 8GB，**large-v3（约 4GB）+ 7B（约 5GB）不能同时驻留** → 串行：转写完再翻。
- 翻译要**带上下文**：日语经常省略主语，逐句翻人称全乱。每批带前 3 条原文 + 译文。
- prompt 按语种分支（`ja` / `en` / `auto`），中文输出统一简体、保留口语语气、不要书面化。

### 6.3 配置

```python
RB_SUBS_ENGINE: str = os.environ.get("RB_SUBS_ENGINE", "local")   # local | openai | off
RB_SUBS_ASR_MODEL: str = os.environ.get("RB_SUBS_ASR_MODEL", "medium")
RB_SUBS_THREADS: int = int(os.environ.get("RB_SUBS_THREADS", "6"))
RB_SUBS_AUTO: bool = os.environ.get("RB_SUBS_AUTO", "true").lower() == "true"  # 缓存到 N 片自动起
```

`RB_SUBS_ENGINE=off` 时只做 ASR 不翻译（字幕显示日文/英文原文），这条降级路径要有。

---

## 7. 红线

1. **不扫未缓存分片、不为没落盘的片请求原站。** 和预扫同一条：触发回源等于偷偷整片下载，javrate token 还会过期。
2. **不要把模型打进扩展。** MV3 禁止原生二进制，Service Worker 会被回收，7GB 模型也过不了商店审核。
   模型只跑在 `127.0.0.1:8765` 那个 Python 进程里。
3. **不要重写整个 jsonl。** 两个文件都是 append-only，进程被杀最多丢 20 条；改成就地重写会在断电时整份损坏。
4. **不要用 `video.currentTime` 直接查表。** `mode=cached` 的时间轴是压缩的，必须过 `buildTimeMap()`。
5. **不要在播放头之前显示未到的字幕。** 生成跟不上就提示「生成中」，错位比空白更毁体验。
6. **不要 `except Exception` 收尾删除/清理逻辑** —— 环境垫片会用 `SystemExit` 中止，服务会当场退出（HANDOVER 红线 11）。
7. **不要动 `/hls/*`、`/l/{key}/index.m3u8`、`grab-hook.js` 的改写逻辑。** 缓存链路是好的。
8. **不要给分片剥伪装头**（MissAV 的 `.jpeg` 是纯 TS）。
9. **不要在主线程里跑 ASR。** 一切推理都在后台线程，播放器一旦卡帧就说明放错地方了。
10. 推不推 GitHub **由用户决定**，不要自作主张 push。

---

## 8. 验收

```powershell
cd E:\codex\2026-11-22\wo-x\work\web-video-beauty-mv3\cache-server

# ① 命令行跑一条（不用开服务）
.\.venv\Scripts\python.exe subs.py avbebe.com_archives_357404
#   期望：处理完 130 片，打出 cues 数 / 语种 / 有效语音占比

# ② 文件落地
type "$env:USERPROFILE\Videos\grab-cache\avbebe.com_archives_357404\subs.src.jsonl" | Select-Object -First 5

# ③ 接口
curl http://127.0.0.1:8765/api/subs/avbebe.com_archives_357404
curl http://127.0.0.1:8765/subs/avbebe.com_archives_357404 | more

# ④ 浏览器（阶段 3）
#   原站播放 + 面板里打开「字幕」→ 画面底部出现字幕，拖动进度条后 1 秒内跟上
#   console: window.__RB_SUBS_DEBUG__.stats   // {cues, shown, lang, lagSec}
#   本地页：http://127.0.0.1:8765/play/avbebe.com_archives_357404
```

**质量基准**（用现场那条日语样本，`scripts/probe_asr.py` 已有）：

```
有效语音 95% / 110 句 / small 模型 4.6× 实时
已知错例：ジ・アニメーション、自己自得（应为 自己満足）
→ medium 以上应能修掉大半；large-v3 基本全对
```

**翻译质量用人工看**：抽 20 句，读一遍，判断是不是「能看懂的对话」而不是「语法正确的机翻」。

---

## 9. 工作量（不是估出来的，是照着预扫的规模推的）

| 步骤 | 内容 | 量 |
|---|---|---|
| 1 | `subs.py` 抽音频 + ASR + 增量 | 2 小时 |
| 2 | `subs_api.py` + 前端 `/subs/{key}` | 1 小时 |
| 3 | `subtitles.js` + 面板开关 + 双语样式 | 1.5 小时 |
| 4 | 翻译接入（云端半天内、本地再多半天） | 0.5–1 天 |

阶段 1–3 一天内可跑通，此时**只有日文/英文字幕但已可用**。

---

## 10. 明确不要做

- ❌ 不做实时流式 ASR（不需要，超前 30 秒足够）
- ❌ 不做音频回放/配音（TTS 是另一个项目）
- ❌ 不动 26 项美颜参数、不动预扫逻辑、不动缓存策略
- ❌ 不为了省事把未缓存区间也送去云端转写（等于整片下载 + 上传，双重违规）
- ❌ 不在扩展里加 `nativeMessaging` 或任何原生依赖

</details>
