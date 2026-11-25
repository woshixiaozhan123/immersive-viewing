# Third-Party Notices

This project makes use of or downloads the following third-party open-source components and models:

## Google MediaPipe Tasks Vision (`@mediapipe/tasks-vision`), `face_landmarker.task` & `hair_segmenter.tflite`
- **Source**: https://github.com/google-ai-edge/mediapipe
- **Models**:
  - https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker
  - https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter
- **License**: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- **Usage**: Downloaded locally via `npm run setup` (`scripts/fetch-mediapipe.mjs`) and bundled offline inside `vendor/mediapipe/` for on-device 478-point face landmark detection and hair segmentation inside Web Workers, plus optional server-side `prescan.py`. No video frames or landmarks leave the user's machine.

## hls.js
- **Source**: https://github.com/video-dev/hls.js
- **License**: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- **Usage**: Bundled locally at `cache-server/web/vendor/hls.min.js` for the built-in local media library playback page.

## faster-whisper / CTranslate2 & OpenAI Whisper (`small`)
- **Source**:
  - https://github.com/SYSTRAN/faster-whisper
  - https://github.com/OpenNMT/CTranslate2
  - https://huggingface.co/Systran/faster-whisper-small
- **License**: MIT License
- **Usage**: Optional on-device speech recognition for local cached video segments.

## llama.cpp (`llama-server`)
- **Source**: https://github.com/ggml-org/llama.cpp
- **License**: MIT License
- **Usage**: Optional local GGUF inference server downloaded on demand by `cache-server/native-host/setup-local.ps1` (never bundled in the MV3 extension).

## Optional Local Translation Models (Downloaded On Demand by User)
- **Tencent Hunyuan `Hy-MT2-1.8B-GGUF`** (https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF) — governed by the Tencent Hunyuan open-source license on the model repository.
- **Alibaba `Qwen2.5-3B-Instruct` / `Qwen2.5-7B-Instruct` GGUF** (https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF, https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF) — Apache License 2.0.

## Local Companion Server Runtime & Media Tools
- **FastAPI** / **Uvicorn** / **Pydantic** / **curl_cffi** (MIT License)
- **FFmpeg** (https://ffmpeg.org/, LGPL/GPL depending on user's installed build; invoked externally as a local CLI).

## Architectural Inspirations
- MV3 `<video>` WebGL overlay shell patterns inspired by `anime4nerd` and `virtual-webcam`.
- Off-main-thread MediaPipe CPU XNNPACK Worker & WebGL skin smoothing patterns inspired by `mirotalksfu` video effects and `mouth-acid`.
