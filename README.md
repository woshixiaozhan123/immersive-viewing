# 沉浸式观影（桌面 Chromium MV3 + iOS Safari）

> 本机离线网页视频增强套件 —— 集 **WebGL 单 Pass 26 项实时美颜（MediaPipe 478 点 + 发丝分割）**、**本地 AI 离线中文字幕翻译（Whisper + 混元 Hy-MT2）**、**按站透明 HLS 缓存** 与 **自制播放器控制条** 于一体，无需云端 API、不上传任何视频帧。同时提供支持 **剧场全屏 + 一键 90° 横屏** 的 iOS Safari 用户脚本。

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-38bdf8?style=flat-square)](#)
[![iOS Safari Userscript](https://img.shields.io/badge/iOS-Safari%20Userscript-a855f7?style=flat-square)](#ios-safari-安装与横屏全屏)
[![WebGL + MediaPipe](https://img.shields.io/badge/Engine-WebGL%20%2B%20MediaPipe%20478-ec4899?style=flat-square)](#)
[![Changelog](https://img.shields.io/badge/Changelog-更新日志-f59e0b?style=flat-square)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-10b981?style=flat-square)](LICENSE)

---

## 核心特性

- **100% 本机离线推理与渲染**：所有视频帧、人脸关键点与发丝分割均在用户本机处理，零远端 API、零数据上报。
- **可选：视频本地缓存 + 离线预扫防掉妆 + 内置播放器**（见下方「本地缓存与内置播放器」）：边看边把分片落到本地磁盘，支持对已缓存分片离线预扫人脸关键点（`prescan`）并在回看时查表兜底、显著减少侧脸/模糊/远景掉妆；打开 `http://127.0.0.1:8765/` 即可回看，**原站关掉、token 过期都不影响**，完整保留 26 项美颜面板。
- **最小权限 & 按域名显式开关**：美颜面板与控制条可按需交互，透明 HLS 缓存模块（`grab-hook`）与原站自制控制条（`player-bar`）**默认关闭**，由用户在美颜面板中按站点手动开关与即时热切（B 站 / YouTube 单独由 `cache-hook` 处理 MSE 流）。
- **Wink / 剪映专业级 26 项分项美颜（单 Pass WebGL 管线）**：
  - **美肤（7 项）**：磨皮（12-tap 保边双边近似）、质感保留（高频肤质细节还原，避免塑料脸）、美白（高光保护冷白提亮）、红润（苹果肌暖色提气色）、去黑眼圈、淡法令纹、去油光（T 区高光柔化）。
  - **美型（8 项）**：瘦脸（下颌线收窄）、窄颧骨、下巴长短（`-50 ~ +50` 双向精调）、大眼、眼尾上扬（`-50 ~ +50` 双向精调）、瘦鼻、嘴型大小（`-50 ~ +50` 双向精调）、微笑唇；内置纵横比校正与侧脸对称度 `yawFactor` 自动衰减，避免侧脸背景拉扯。
  - **美妆（5 项）**：亮眼、立体修容（鼻影 + 下颌微阴影）、润唇口红 + **4 款唇色风格**（裸粉 / 蜜桃橘 / 玫瑰豆沙 / 复古正红）、牙齿美白。
  - **调色（6 项）**：清晰锐化（眼唇细节保边增强）、亮度曝光（`-50 ~ +50`）、对比度（`-50 ~ +50`）、饱和度（`-50 ~ +50`）、色温冷暖（`-50 ~ +50`）、氛围柔光（Orton 风格高光漫射）；全画幅调色在无脸或降级回退场景下同样生效。
  - **预设与方案管理**：内置 7 档风格预设（自然清透 / 冷白质感 / 日系柔光 / 纯欲微调 / 网感精修 / 减龄打底 / 归零）、本地「我的方案」保存、参数 JSON 导入导出与 **Wink/小红书中文配方文本一键解析**（直接粘贴 `小脸+20 眼睛倾斜-29 鼻子大小+34 口红/豆沙+18 饱和度-20 色温-8` 即可自动识别并跳过非面部项），双击任意滑块可单项归零。
- **零滞后帧同步 + 独立发丝分割**：
  - 渲染主循环通过 `VideoFrame` 原子锁帧匹配对应视频帧（0.00ms 音画脸型滞后），由 `requestVideoFrameCallback`（自动回退 `requestAnimationFrame`）驱动；
  - 独立 `face-worker.js`（GPU Delegate 优先、CPU XNNPACK 回退）结合主脸 IoU 锁定、运动自适应死区稳定器与 `448–512px` 小脸动态高倍 ROI 裁切（净像素提升 `+34% ~ +66%`）；
  - 独立 `hair-worker.js`（MediaPipe `hair_segmenter`，每 2 帧分割 1 次，GPU 冷启动预热 + 6s 看门狗）精准剔除刘海与碎发区域，防止磨皮美白糊白发丝。
- **主流播放器通用适配 & 保护边界尊重**：
  - 自动适配 **XGPlayer（抖音等）**、**Plyr**、**Bilibili**、**YouTube** 与通用 HTML5 `<video>`（含开放 Shadow DOM 与同源 `iframe`）；
  - 精准支持 `object-fit: contain` / `cover` / `fill` 叠层对齐、悬停小预览降权、上下刷视频切条自动跟随、失焦暂停静态调参、容器全屏保持与原生 `<video>` 全屏自动回退；
  - 严格区分 **保护信号**（检测到 EME `mediaKeys` / `encrypted` 事件立即跳过取帧并保持原画）与 **取帧结果**（`可取帧 / 等待画面 / 跨域受限 / EME 已跳过 / 失败未确认`）；
  - **L0–L3 自动性能降级** 与 `webglcontextlost` 恢复，关闭美颜或离页时完整释放 Worker 与 WebGL 上下文。

---

## 架构概览

```mermaid
flowchart LR
  V["HTML5 &lt;video&gt;"] -->|rVFC / rAF 30fps<br/>VideoFrame 零滞后帧同步| GL["WebGL 单 Pass 渲染<br/>UV微整形 + 12-tap磨皮 + 多通道遮罩"]
  V -->|动态小脸 ROI 448-512px<br/>零拷贝 ImageBitmap| FW["face-worker.js (GPU/CPU)<br/>MediaPipe 478 点 + 死区稳定"]
  FW -->|未检出时查表兜底| PS["可选 landmarks.bin<br/>132点离线预扫表 (timeMap对齐)"]
  FW -->|256×256 面部语义遮罩| GL
  FW -->|每2帧同步一次ROI| HW["hair-worker.js (GPU/CPU)<br/>MediaPipe 发丝分割遮罩"]
  HW -->|剔除刘海/碎发| GL
  PS -->|恢复人脸框并反馈下一帧ROI| GL
  GL --> O["非侵入 Canvas 叠层<br/>pointer-events: none"]
  UI["Popup / 页内悬浮面板"] <-->|chrome.tabs / runtime| GL
```

---

## 快速安装（桌面端 Chromium 浏览器）

### 方式一：直接下载 Release 预构建包（推荐普通用户）
1. 前往 [Releases 页面](https://github.com/woshixiaozhan123/immersive-viewing/releases) 下载 `immersive-viewing-v1.3.0.zip` 并解压（内含全部离线美颜模型与本地字幕/缓存服务脚本，无需安装 Git）。
2. 打开浏览器扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
   - ego(lite)：`ego://extensions`
3. 开启右上角 **开发者模式** → 点击 **加载已解压/未打包的扩展程序** → 选择解压后的文件夹（包含 `manifest.json` 的目录）。
4. 打开任意 HTML5 视频页，点击工具栏扩展图标即可查看诊断并开启实时美颜。

### 方式二：从源码克隆构建（开发者）
> 需要 Node.js >= 18（零 npm 第三方运行时依赖）。

```bash
git clone https://github.com/woshixiaozhan123/immersive-viewing.git
cd immersive-viewing

# 1. 下载官方离线 MediaPipe WASM 与 478 点人脸模型到 vendor/mediapipe/
npm run setup

# 2. 校验语法、manifest 与资源完整性
npm run check

# 3. 打包可直接分发/提审的干净 zip 到 dist/
npm run build
```

> 若跳过 `npm run setup` 直接加载源码，扩展依然可以正常运行，并自动进入 **「WebGL 肤色保边回退模式」**（磨皮 / 质感保留 / 美白 / 红润 / 去油光 / 全部 6 项画面调色立即可用）。

---

## 本地缓存、离线字幕与内置播放器（完全可选）

> **不安装本地服务，扩展核心能力照常工作。** 26 项美颜、发丝分割、播放器控制条、B站/YouTube 的 v2 缓存全都不依赖它。
> 只有「透明 HLS 缓存」「离线 AI 中文字幕」「关键点预扫」「本地媒体库」需要本机伴侣服务（`cache-server/`）。

`cache-server/` 是运行在 `127.0.0.1:8765` 的本地 FastAPI 服务。**支持浏览器 Native Messaging 按需自动拉起（平时后台 0 进程）与两级休眠（模型闲置 90–180 秒自动卸载，服务 30 分钟无真实业务活动自动退出）。**

### Windows 一键部署（推荐）

先在 Chrome / Edge / ego 中以「加载已解压的扩展程序」加载本项目根目录，然后执行一次：

```powershell
# 一键安装（会按本机内存给出默认推荐，并弹出模型选型菜单）
powershell -ExecutionPolicy Bypass -File cache-server/native-host/setup-local.ps1

# 国内网络建议加上 HuggingFace 镜像：
powershell -ExecutionPolicy Bypass -File cache-server/native-host/setup-local.ps1 -HfMirror

# 也可直接指定/切换模型（hy-mt2-1.8b | qwen2.5-3b | qwen2.5-7b）：
powershell -ExecutionPolicy Bypass -File cache-server/native-host/setup-local.ps1 -Model qwen2.5-3b -HfMirror

# 只用本地缓存和人脸预扫、不装离线字幕模型：
powershell -ExecutionPolicy Bypass -File cache-server/native-host/setup-local.ps1 -SkipSubtitles
```

如果你本机已经备好了 Python 环境、模型与 `llama-server`，只需运行注册脚本（会自动探测扩展 ID、模型路径与本机环境）：

```powershell
powershell -ExecutionPolicy Bypass -File cache-server/native-host/install-host.ps1
```

安装完成后去扩展管理页刷新一次「沉浸式观影」即可生效，日常无需再手动启动终端。如需前台调试也可手动启动：

```bash
cd cache-server
python main.py          # 媒体库：http://127.0.0.1:8765/
```

1. **透明缓存**：同时拦截 `window.Hls`、`<video src>` 与 `XHR / fetch` 中的 `.m3u8`，**支持单轨 TS 及音视频分离 fMP4 HLS**（`#EXT-X-MEDIA:TYPE=AUDIO` + `#EXT-X-MAP`）。每个分片先问本地、未命中才回源并顺手存一份。
2. **媒体库与一键预扫**：点击扩展面板「媒体库↗」或访问 `http://127.0.0.1:8765/`，即可离线回看（原站关闭或 token 过期不受影响），并可在卡片上点击「**预扫人脸**」离线提取 132 点关键点。

### 离线中文字幕（日/英 → 简体中文）

在面板的「本地字幕」里选「中文字幕」或「双语字幕」，支持拖入「**字幕字号**（70%–160%）」和「**字幕高度**（+0%–35%）」微调位置避开原片硬字幕，按域名独立开关记忆。

- **只读本地已缓存分片**（绝不回源偷拉流量），优先处理播放头前方 ~30 秒窗口，拖动进度条会取消旧任务并优先计算新位置；已生成结果以 `subs.src.jsonl` / `subs.zh.jsonl` 持久化复用。
- **转写与翻译**：`faster-whisper small`（支持独立音频流与 fMP4 `init.mp4` 拼接抽音轨） + 本地 GGUF 翻译模型（`llama-server` 驱动，安装时可按配置自选）。

#### 翻译模型选型与硬件配置推荐

| 模型档位 | 参数 / 量化体积 | 最低要求 | 推荐配置 | 特点与适用建议 |
|---|---|---|---|---|
| **Hy-MT2-1.8B Q4**（轻量极速） | 1.8B / ~1.1 GB | 8 GB 内存（纯 CPU 可跑） | 8–16 GB 内存 / 集显或入门独显 | 专为多语互译优化、启动最快、内存占最小，日/英转中日常追剧够用 |
| **Qwen2.5-3B Q4**（均衡进阶） | 3B / ~2.0 GB | 12 GB 内存 | **16 GB+ 内存 + 8 核 CPU 或 4–6 GB+ 独显** | 对日/英口语长难句、省略主语的语境理解更稳，**16 GB 及以上机器首选** |
| **Qwen2.5-7B Q4**（高配旗舰） | 7B / ~4.7 GB | 16 GB 内存 + 6 GB+ 显存 | **24 GB+ 内存 + 8 GB+ 独显**（如 RTX 4060） | 语义理解与译文自然度最高，纯 CPU 会偏慢，建议有独显 Vulkan 加速再选 |

> 切换模型无需改代码：重跑 `setup-local.ps1 -Model <名称>`，或把任意兼容 `llama.cpp` 的 GGUF 对话模型路径填进 `RB_SUBS_MT_MODEL`（或 `native-host/env.json`），服务端会自动识别文件指纹并重新测速选档。
- **硬件自适应分级 + 双模型热复用**：
  - 按主机 CPU 逻辑核数与总内存自动分 **低（low）/ 中（medium）/ 高（high）** 三档（高配机放开 Whisper 至 `min(10, 核/2)` 线程并开启双模型热复用；低配机如 8 GB 内存保持串行“用完即杀”）。
  - **实时内存安全阀**：运行中系统可用内存跌破阈值（默认 3.5 GB）自动卸载闲置热模型并降回安全模式。
  - **测速结果持久化**：按 CPU / GPU / 模型指纹缓存在 `cache-server/native-host/profile-cache.json`，自动切换 `CPU 兼容`、`CPU 多核` 或 `GPU 翻译（Vulkan）`，重启无需重复测速。

<details>
<summary>手动安装字幕依赖与常用环境变量</summary>

```powershell
cd cache-server
python -m pip install -r requirements.txt -r requirements-subtitles.txt huggingface_hub
python -c "from huggingface_hub import snapshot_download; print(snapshot_download('Systran/faster-whisper-small'))"
$env:RB_SUBS_LLAMA_BIN = "C:\tools\llama.cpp\llama-server.exe"
$env:RB_SUBS_LLAMA_GPU_BIN = "C:\tools\llama.cpp\vulkan\llama-server.exe" # 可选：Vulkan GPU 版
$env:RB_SUBS_MT_MODEL = "C:\models\Hy-MT2-1.8B-Q4_K_M.gguf"
python main.py
```

- `RB_SUBS_WHISPER_DIR`：自定义 Whisper 目录
- `RB_SUBS_THREADS` / `RB_SUBS_BEAM_SIZE` / `RB_SUBS_WARM_TTL_SEC`：手动覆盖自适应线程数、`beam_size` 与热模型保活秒数
- `RB_IDLE_SHUTDOWN_MIN`：无真实业务请求与后台任务后自动退出分钟数（默认 `30`，`<=0` 关闭）

混元模型与引擎可从 [tencent/Hy-MT2-1.8B-GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF) 与 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases) 获取。

</details>

### 缓存默认是关的，按站点自己开

不想要某个站的视频被存下来？默认就是关的。要缓存时，在美颜面板「当前视频」卡片里打开 **「本站缓存」** 开关即可 —— 按域名记忆，开启后正在播的视频会原地热切到本地代理，不用刷新。

### 也可以自己随时删

缓存进度下面就是两个删除按钮，确认后立刻释放磁盘，不用去媒体库翻：

```
已缓存 130/374 片 · 35% · 70 MB
删除本视频 · 130 片          清空本站 · 1 条 · 70 MB
```

- **删除本视频**：只删当前这条
- **清空本站**：删该站点在本地缓存的全部视频（按条目真实所属站点算，不是当前页面的域名）
- 如果「本站缓存」开关还开着，删完会从当前位置重新开始缓存，弹窗里会提示

### 缓存会自动清理

服务后台每小时巡检一次，两条规则同时生效：

| 规则 | 默认 | 说明 |
|---|---|---|
| 保留天数 | 7 天 | 超过 7 天没看过（`lastAccessAt`）就删 |
| 容量上限 | 20 GB | 超了就按「最久没看」从旧到新删，直到降下来 |

媒体库页顶部会显示当前占用和规则，带「立即清理」按钮。规则可用环境变量调整：

```bash
RB_CACHE_MAX_AGE_DAYS=7      # 0 = 不限天数
RB_CACHE_MAX_GB=20           # 0 = 不限容量
RB_CACHE_SWEEP_INTERVAL_MIN=60
RB_CACHE_SWEEP=false         # 完全关掉自动清理
```

### 离线关键点预扫（可选，减少复杂镜头掉妆）

侧脸、运动模糊或远景小脸容易超过单帧实时检测极限，导致短暂回退为全帧肤色美颜。预扫模块可在本地对**已落盘的 TS 分片**做一次 4fps 离线扫描（**绝不回源拉流量**），生成 `132` 个核心点位的紧凑二进制表 `landmarks.bin`（10 分钟视频约 1.36 MB），在内置播放器回看时先查表兜底：

```bash
# 单跑扫描一条已缓存视频，并用自检脚本验证输出
cd cache-server
python prescan.py <safeKey>
python ../scripts/check_landmarks.py ~/Videos/grab-cache/<safeKey>/landmarks.bin
```

- **HTTP 接口**：`POST /api/prescan/{key}`（触发异步扫描，`?force=1` 重扫）、`GET /api/prescan/{key}`（查进度）、`DELETE /api/prescan/{key}`（删预扫文件）、`GET /lm/{key}`（下载二进制表），`/api/library` 同步返回 `hasPrescan` 标记。
- **时间轴对齐**：`mode=cached` 仅播放已缓存分片时，`player.html` 会基于实际 `#EXTINF` 时长生成分段映射表，确保查表不因跳过未缓存分片而错位。
- **环境变量**：`RB_PRESCAN_FPS`（默认 `4`）、`RB_PRESCAN_MAX_FRAMES`（默认 `400000`）、`RB_PRESCAN_AUTO`（默认 `false`）。
- 实测同一 2 分钟片段开启预扫后，`face_mask` 覆盖率较关闭前相对提升 `+50%`，渲染帧率仍稳定在 `~30 fps`。

**为什么缓存要单独跑一个进程，而不是做进扩展里**：

- 目标 CDN 会校验 TLS 指纹，需要 `curl_cffi impersonate="chrome"` 才能拿到分片；
- 一集长片可能好几 GB，落到磁盘比塞 IndexedDB/OPFS 可靠（MV3 service worker 30 秒就被回收，也扛不住长下载）；
- 抽帧缩略图与离线解码要用本机 ffmpeg，离线关键点扫描也避免占用浏览器播放线程。

**服务没启动时会自动降级**：扩展探测 `/health` 失败 → `serverOnline=false` → 不改写任何 m3u8 → 原站播放器行为与没装扩展完全一致。

- 播放列表由**磁盘状态**现场生成，默认只列已落盘分片，原站 token 过期也能完整回看。
- 详细变更记录与实测摘要见 [CHANGELOG.md](CHANGELOG.md)。

---

## iOS Safari 安装与横屏全屏

仓库内置与桌面端完全同步的 iOS Safari 用户脚本：[ios/realtime-beauty-ios.user.js](ios/realtime-beauty-ios.user.js)（同样具备全部 26 项参数、7 档预设、Wink 中文配方解析与可选 478 点追踪）。

### 安装步骤（Userscripts / Stay）
1. 在 App Store 安装免费开源的 **Userscripts**（或 **Stay**），并在 iOS「设置 → Safari 浏览器 → 扩展」中开启并授予网站权限。
2. 下载或直接从 Raw 链接安装脚本：
   `https://raw.githubusercontent.com/woshixiaozhan123/immersive-viewing/main/ios/realtime-beauty-ios.user.js`
3. 若使用 **Userscripts**：将脚本保存到 iCloud Drive /「我的 iPhone」下的 Userscripts 目录，刷新 Safari 视频页即可在右下角看到悬浮球。

### iOS 美颜剧场全屏 & 90° 横屏
- iOS 原生视频全屏会由系统 `AVPlayer` 接管并遮挡网页叠层；点击悬浮球旁的 **`⛶ 全屏`**（或面板底部的 **`⛶ 美颜全屏`**）即可进入美颜剧场全屏，完整保留美颜、进度条拖拽、倍速和实时调参。
- 即使手机开启了「竖排方向锁定」，点右上角 **`↻ 横屏90°`** 也能一键旋转横屏铺满观看。

---

## 浏览器兼容性与实测表现

在开启硬件加速的 Windows 桌面端通过可控测试页与主流视频站实测：

| 浏览器 | 状态 | 离线 478 点人脸遮罩 | 典型渲染耗时 (P95) |
| :--- | :--- | :--- | :--- |
| **Google Chrome** | ✅ 已验证 | 支持（CPU XNNPACK） | ~3.0–3.3 ms（L0） |
| **Microsoft Edge** | ✅ 已验证 | 支持（CPU XNNPACK） | ~3.0 ms（L0） |
| **ego(lite)** | ✅ 已验证 | 支持（CPU XNNPACK） | ~2.9–3.0 ms（L0） |

---

## 目录结构

```text
immersive-viewing/
├── manifest.json                 # MV3 清单（icons + wasm-unsafe-eval）
├── CHANGELOG.md                  # 版本与功能更新日志
├── icons/                        # 16 / 48 / 128 扩展图标
├── popup/                        # 26 项 Wink/剪映专业分项调参面板、预设、JSON 方案与诊断
├── content/
│   ├── engine.js                 # 主引擎：零滞后帧同步、WebGL管线、L0-L3降级、prescan兜底
│   ├── overlay-ui.js             # 页面悬浮调参面板、字幕样式控制、按站缓存开关与媒体库入口
│   ├── player-bar.js             # 全站可选原站内嵌播放控制条
│   ├── subtitles.js              # 原站与本地播放器共用的离线字幕渲染与状态提示
│   └── grab-hook.js              # 透明 HLS 缓存 hook（Hls.js + video.src + XHR/fetch 拦截）
├── worker/
│   ├── face-worker.js            # 离主线程 MediaPipe 478 点推理与运动自适应稳定器
│   └── hair-worker.js            # 离主线程 MediaPipe 发丝分割（刘海/碎发防误磨皮）
├── ios/                          # iOS Safari 用户脚本（26 项调参 + 美颜剧场全屏 + 90° 横屏）
├── cache-server/                 # 可选本地服务：透明缓存 + 离线字幕 + 预扫 + 媒体库（FastAPI）
│   ├── hls_proxy.py              #   v4 分片级透明缓存（单轨 TS + 音视频分离 fMP4 HLS）
│   ├── subtitles*.py             #   离线字幕调度、双模型热复用池、硬件自适应分级与测速缓存
│   ├── prescan.py / prescan_api.py # 离线人脸关键点预扫（132点二进制 + HTTP API）
│   ├── idle.py / maintenance.py  #   30 分钟空闲自动退出看门狗 + 缓存定时自动清理
│   ├── native-host/              #   Native Messaging 按需自动启动宿主与 Windows 一键安装脚本
│   ├── webui.py                  #   媒体库 / 内置播放器 / 本地播放列表 / 缩略图（含 fMP4）
│   └── web/                      #   播放器前端（hls.js + chrome API 垫片 + 一键预扫人脸）
├── vendor/mediapipe/             # 离线 MediaPipe 模型与 ES Module WASM（npm run setup 拉取）
├── test-page/index.html          # 可控边界测试页（双人脸、同源iframe、cover/contain、全屏、EME）
├── scripts/                      # setup / check / check_landmarks / build 脚本
└── .github/workflows/ci.yml      # GitHub Actions 自动校验与打包工作流
```

---

## 已知边界与限制

- **受 DRM (EME) 保护的流媒体**：遵循浏览器安全与版权机制，检测到 `mediaKeys` 或 `encrypted` 事件后主动跳过取帧并保持原画播放。
- **无 CORS 头的跨域直链视频**：浏览器 `texImage2D` 会按规范抛出 `SecurityError`，诊断面板将明确标记为「跨域受限」并保持原画（MSE `blob:` 流与同源流不受此限制）。
- **跨域 `iframe` 与自绘 `<canvas>` 播放器**：当前在诊断面板标记为待适配提示。
- **严格 CSP 网站**：若目标站点 CSP 禁止 `blob:` Worker，引擎会自动平滑降级至「肤色保边回退模式」，不中断播放。

---

## 开源协议与致谢

本项目采用 [MIT License](LICENSE) 开源；第三方模型与组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。欢迎通过 [CONTRIBUTING.md](CONTRIBUTING.md) 参与贡献。
