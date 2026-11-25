# 更新日志（Changelog）

本文档记录 **沉浸式观影（原实时美颜 / realtime-beauty）** 的重要功能演进、修复与架构调整，按时间倒序排列。

---

## [1.3.1] - 2026-11-25

### 新增与优化（iOS Safari 用户脚本美颜全面升级）
- **发丝防糊保护（[ios/realtime-beauty-ios.user.js](ios/realtime-beauty-ios.user.js)）**：新增独立内联 `HAIR_WORKER_SOURCE`（`hair_segmenter.tflite`），在开启 478 点后按需剔除刘海与碎发区域的磨皮遮罩，解决浅色/逆光发丝刷白问题。
- **高精人脸裁切 + 超清 1080p 渲染档位**：将半身/远景裁切门槛与推理边长对齐桌面端（`45%/55%` + `2.8×` 紧裁剪 + `448` 下限），并在面板新增「超清 1080p 渲染」开关（剧场最高 DPR 2.0 / 1080p，保留 L0→L2 自动降级保流畅）。
- **磨皮质感微调 + 剧场长按原画对比 + 一键检查更新**：双边磨皮加入色度联合边缘保持与微质感限幅回注减少假面感；剧场全屏支持长按画面对比原画；统一更名并补充 `@updateURL` / `@downloadURL`（Stay 一键检查更新）及随 Release 分发。

---

## [1.3.0] - 2026-11-25

### 新增（Added）
- **独立置顶美颜小窗（美颜 + 离线 AI 翻译字幕全保留）**：
  - [content/pip.js](content/pip.js)：首选 Chromium Document Picture-in-Picture 在独立置顶小窗内实时镜像 WebGL 美颜画布（美颜关闭时无缝切回原画面）并渲染中文字幕 / 双语字幕（继承字号与高度配置，随窗口自适应缩放），附带悬停迷你控制条（播放/暂停、进度拖拽、静音、倍速、小窗内开关美颜与切换字幕模式、一键回原页及快捷键）。
  - **后台切页保活**：小窗打开期间切换到其他标签页时，[content/engine.js](content/engine.js) 切换为小窗 `requestAnimationFrame` 驱动循环，[content/subtitles.js](content/subtitles.js) 同步保持离线转写翻译拉取与渲染，关闭小窗后立即恢复原有节能停顿。
  - **自动降级与原生画中画字幕兜底**：不支持 Document Picture-in-Picture 的环境自动降级为离屏 2D 合成画布 + `captureStream(30)` 代理画中画；遇到严格跨域画布限制再优雅回退原生 `requestPictureInPicture()`，并由 [content/subtitles.js](content/subtitles.js) 自动挂载 `VTTCue` 原生字幕轨道兜底。
  - **全入口接入**：自制播放控制条（[content/player-bar.js](content/player-bar.js)）、悬浮美颜面板（[content/overlay-ui.js](content/overlay-ui.js)）及本地媒体库内置播放器（[cache-server/web/player.html](cache-server/web/player.html)，支持 `P` 键快捷开关）均已接入。

---

## [1.2.0] - 2026-11-25

### 新增（Added）
- **本地离线 AI 中文字幕（日/英 → 简体中文）**：
  - [cache-server/subtitles.py](cache-server/subtitles.py)、[subtitle_inference.py](cache-server/subtitle_inference.py)、[subtitle_profiles.py](cache-server/subtitle_profiles.py)、[subtitle_api.py](cache-server/subtitle_api.py)、[content/subtitles.js](content/subtitles.js)：仅读取本机已落盘分片，使用 `faster-whisper small` 转写 + 本地 `llama-server` 跑混元 `Hy-MT2-1.8B-Q4_K_M` 翻译，按播放头超前 30 秒生成、支持跳播优先与旧任务即时取消，支持中文字幕 / 双语字幕按域名记忆。
- **硬件自适应分级 + 双模型热复用 + 测速缓存**：
  - 取消原先 4 核硬限制，按主机内存与 CPU 逻辑核数自动分级（`low` / `medium` / `high`，高配机放开 Whisper 至 `min(10, 核/2)` 线程、`beam_size=2`），引入 `WhisperWorkerPool` 与 `TranslatorPool` 连续播放热复用，闲置 90–180 秒一级休眠卸载，实时可用内存跌破阈值时自动触发安全阀降级；选档测速按硬件/模型指纹持久化至 `profile-cache.json`。
- **Native Messaging 按需自动启动 + 30 分钟空闲自动退出**：
  - [cache-server/native-host/](cache-server/native-host/)（含 `setup-local.ps1` 一键环境安装脚本与 `install-host.ps1` 注册脚本）+ [cache-server/idle.py](cache-server/idle.py) + [background/grab-bridge.js](background/grab-bridge.js)：平时后台 0 进程，仅在开启缓存、字幕、媒体库或删除缓存时按需拉起；看门狗忽略 `/health` 探针，连续 30 分钟无真实业务活动且无后台任务时优雅退出。一键安装支持按硬件配置交互式或 `-Model` 自选翻译模型（`Hy-MT2-1.8B` / `Qwen2.5-3B` / `Qwen2.5-7B`）。
- **音视频分离 & fMP4 HLS 支持 + XHR/fetch 拦截**：
  - [content/grab-hook.js](content/grab-hook.js) 新增 `XMLHttpRequest.open` 与 `window.fetch` 的 `.m3u8` 改写，覆盖未挂载全局 `window.Hls` 的 webpack 打包播放器；
  - [cache-server/hls_proxy.py](cache-server/hls_proxy.py)、[webui.py](cache-server/webui.py)、[subtitles.py](cache-server/subtitles.py) 全面支持 `#EXT-X-MEDIA:TYPE=AUDIO` 独立音频流与 `#EXT-X-MAP` fMP4 初始化头（含在线缓存、字幕抽音轨、离线播放与缩略图抽帧）。
- **UI 打磨与更名「沉浸式观影」**：
  - 扩展及本地播放器对外名称统一升级为「**沉浸式观影**」；新增面板「字幕字号 / 高度」微调滑块、按状态智能提示、「媒体库↗」快捷入口与媒体库卡片「预扫人脸」一键触发按钮；修复隔离世界导致的「缓存脚本未注入本页」误报。

---

## [1.1.5] - 2026-11-24

### 新增（Added）
- **离线人脸关键点预扫与查表兜底（`prescan`）**：解决侧脸、运动模糊、远景小脸等实时单帧检测容易掉回「肤色保边回退（`skin_fallback`）」的问题
  - [cache-server/prescan.py](cache-server/prescan.py)：针对本地**已缓存 TS 分片**做 4fps 离线扫描（绝不回源拉流量），复用内置 `vendor/mediapipe/face_landmarker.task`；采用 `0.22` 检测阈值 + `isPlausibleFace` 校验 + 2.8× 动态紧裁剪 + 5 窗口高倍补检；抽取并保存 `engine.js` 实际消费的 **132** 个核心点位（脸廓、双目、双眉、内外唇及鼻翼锚点，消除多边形 `(0, 0)` 顶点拖尾伪影），写入定长小端二进制表 `landmarks.bin`（`RBPS v1`，`scale=10000`，`stride=544 B`，10 分钟片约 1.36 MB）与 `landmarks.json`；全局最多允许 1 个并发扫描任务，支持命令行单跑（`python prescan.py <safeKey>`），服务重启时自动重置残留 `running` 状态。
  - [cache-server/prescan_api.py](cache-server/prescan_api.py)：提供 `GET/POST/DELETE /api/prescan/{key}`、`GET /lm/{key}`（静态二进制下发，缺失返回 404 不现场触发扫描）；`/api/library` 列表项新增 `hasPrescan` 标记。
  - [cache-server/config.py](cache-server/config.py)：新增环境变量 `RB_PRESCAN_FPS`（默认 `4`）、`RB_PRESCAN_MAX_FRAMES`（默认 `400000`）、`RB_PRESCAN_AUTO`（默认 `false`）。
  - [scripts/check_landmarks.py](scripts/check_landmarks.py)：新增 `landmarks.bin` 二进制头、体积、时间戳单调性与 20 帧随机抽样自检脚本。
  - [cache-server/web/player.html](cache-server/web/player.html) 与 [content/engine.js](content/engine.js)：本地播放器自动生成 `mode=cached` 压缩时间轴映射 `window.__RB_FULL_TIME_MAP__` 并加载 `/lm/{key}`；仅在实时 Worker `RESULT` 判为无脸时执行 O(log N) 二分查表兜底并恢复 `lastFaceBox`，`this.prescan === null` 时线上扩展链路行为保持 100% 不变。
- **独立发丝分割与真实推理分辨率修复**：
  - [worker/hair-worker.js](worker/hair-worker.js) 与 [scripts/fetch-mediapipe.mjs](scripts/fetch-mediapipe.mjs)：新增基于 MediaPipe `hair_segmenter` 的独立 Web Worker（每 2 帧人脸推理同步分割 1 次，零拷贝 256×256 单通道遮罩，`shader` 内自动剔除刘海与碎发防止糊白漆），并内置冷启动预热与 6 秒看门狗恢复机制。
  - [content/engine.js](content/engine.js)：修复小脸动态裁切下推理边长被压回 `384` 导致净分辨率原地踏步的缺陷，将门槛放宽至 `45%/55%` 并保持 `448–512` 推理边长（半身/特写人脸净像素提升 `+34% ~ +66%`）。
- **v4 透明 HLS 本地缓存、按站开关与本地媒体库 / 播放器**：
  - [cache-server/hls_proxy.py](cache-server/hls_proxy.py)、[content/grab-hook.js](content/grab-hook.js)、[content/grab-relay.js](content/grab-relay.js)：透明接管 `hls.js` / 原生 m3u8 到本地代理，边看边存零额外流量，缓存进度实时显示在美颜面板中。
  - **按站开关与手动删除**：缓存**默认全关**，在面板中按域名开关支持中途不停播热切；提供「删除本视频 / 清空本站」按钮即时释放磁盘。
  - [cache-server/maintenance.py](cache-server/maintenance.py)：后台定时自动清理（默认保留 7 天 / 上限 20 GB），支持媒体库页手动「立即清理」。
  - [cache-server/webui.py](cache-server/webui.py) 与 [cache-server/web/](cache-server/web/)：提供本地媒体库 `GET /`、内置播放器 `GET /play/{safeKey}`（默认 `mode=cached` 离线可看）及无扩展可用的 Chrome API 垫片 `shim.js`。
- **原站内嵌自制播放控制条**：
  - [content/player-bar.js](content/player-bar.js)：支持全站原生视频套用统一播放控制条（进度预览、倍速、音量、画中画、全屏），按域名独立开关记忆。

### 变更与修复（Changed & Fixed）
- **移除废弃 v3 整片下载管线**：清理 `grab_pipeline.py`、`grab_models.py`、`POST /api/grab`、`/local/{key}/out.mp4` 等 56 KB 死代码，统一采用 v4 透明分片缓存。
- **修复控制面板误隐藏行**：修复页面脚本尚未注入时面板开关行被静默隐藏的问题（[content/overlay-ui.js](content/overlay-ui.js)），并明确说明 `cache-server` 为完全可选组件，未启动时扩展零影响。

### 实测验证摘要（1920×1080 真实缓存样本 `avbebe.com_archives_357404`）
- 同 0–120 秒播放窗口 500ms 采样 A/B 对照：关闭预扫 `face_mask` 为 **31.67%**（76/240），开启预扫提升至 **47.50%**（114/240，相对 **+50.0%**），`prescan.hits = 558`，`avgRenderFps` 保持 **29.90 fps**。
- 同时间戳静止帧 Canvas Diff：`11,924` 个变化像素 **100.0%** 落入人脸 ROI 框内，左上角 `(0, 0)` 零多边形拖尾伪影。

---

## [1.1.0] - 2026-11-23

### 新增与优化
- **26 项 Wink / 剪映专业级分项美颜管线**：美肤 7 项、美型 8 项（含纵横比校正与 `yawFactor` 侧脸防拉扯）、美妆 5 项（含 4 款口红色号）、调色 6 项。
- **零滞后帧同步人脸追踪 & 悬浮球 UI**：主视频帧通过 `VideoFrame` 与 `pendingTex` 原子锁帧（0.00ms 滞后），配合紧致 Face-ROI 高清遮罩与页面悬浮调参面板。
- **配方生态与 iOS 用户脚本**：内置 7 档预设（含「减龄打底」）、Wink/小红书中文配方文本解析器，以及支持「美颜剧场全屏 + 一键 90° 横屏」的 [ios/realtime-beauty-ios.user.js](ios/realtime-beauty-ios.user.js)。

---

## [1.0.0] - 2026-11-22

### 初始发布
- 桌面 Chromium MV3 扩展首个开源版本：WebGL 单 Pass 美颜引擎、MediaPipe 478 点人脸遮罩、L0–L3 性能自适应降级、EME/CORS 保护边界检测与 CI 自动打包工作流。
