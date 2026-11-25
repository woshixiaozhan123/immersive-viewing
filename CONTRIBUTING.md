# 参与贡献 · 沉浸式观影（Immersive Viewing）

欢迎提交 Issue 和 Pull Request！

## 本地开发流程

1. 克隆仓库并拉取离线 MediaPipe 模型：
   ```bash
   npm run setup
   ```
2. 在 Chrome（`chrome://extensions`）、Edge（`edge://extensions`）或其它 Chromium 浏览器开启 **开发者模式**，加载仓库根目录。
3. 打开仓库自带的 `test-page/index.html` 测试各项边界场景（`object-fit: cover/contain`、容器全屏、原生全屏、失焦暂停、切集重建 `<video>`、同源 `iframe`、双人脸锁定、EME 加密回退）。
4. 修改代码后运行校验：
   ```bash
   npm run check
   ```
5. 若修改了 `cache-server/` 或 `native-host/` 脚本，请同步检查服务端与安装脚本：
   ```powershell
   .\cache-server\.venv\Scripts\python.exe -m py_compile cache-server\*.py cache-server\native-host\host.py
   powershell -ExecutionPolicy Bypass -File cache-server\native-host\setup-local.ps1 -DryRun
   ```
6. 打包发布 zip：
   ```bash
   npm run build
   ```

## 如何新增站点播放器适配器

在 `content/engine.js` 中：
1. 在 `detectAdapterName(video)` 添加播放器容器特征选择器并返回适配器名称。
2. 在 `getMountContainer(video)` 添加对应的视频包裹容器选择器，使叠层 `<canvas>` 挂载在 `<video>` 紧后方且不遮挡控制栏和弹幕层。
3. 在 `scoreVideo(v)` 的 `isMainPlayer` 选择器列表里补充主播放器特征。

请避免硬编码特定域名，优先通过播放器 DOM 结构特征实现通用适配。
