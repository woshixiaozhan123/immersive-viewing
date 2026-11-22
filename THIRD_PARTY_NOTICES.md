# Third-Party Notices

This project makes use of or downloads the following third-party open-source components:

## Google MediaPipe Tasks Vision (`@mediapipe/tasks-vision`) & `face_landmarker.task`
- **Source**: https://github.com/google-ai-edge/mediapipe
- **Model**: https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker
- **License**: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- **Usage**: Downloaded locally via `npm run setup` (`scripts/fetch-mediapipe.mjs`) and bundled offline inside `vendor/mediapipe/` for on-device 478-point face landmark detection inside a Web Worker. No video frames or landmarks leave the user's browser.

## Architectural Inspirations
- MV3 `<video>` WebGL overlay shell patterns inspired by `anime4nerd` and `virtual-webcam`.
- Off-main-thread MediaPipe CPU XNNPACK Worker & WebGL skin smoothing patterns inspired by `mirotalksfu` video effects and `mouth-acid`.
