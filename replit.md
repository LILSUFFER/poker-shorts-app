# Shorts Cutter

## Overview

Shorts Cutter is a private, single-user tool designed to automatically detect, export, and publish highlight clips from stream recordings as vertical YouTube Shorts (1080x1920). It supports "poker" and "streamer" content types, analyzing uploaded videos using audio peaks, scene changes, and OCR for exciting moments. The application suggests clip candidates, exports polished vertical shorts with stacked layouts, optional watermarks, and subtitles. It sources videos from YouTube, Twitch, Kick, VK Video, and Google Drive via `yt-dlp`. The tool focuses on high-quality output for content creators, not public SaaS.

## User Preferences

Preferred communication style: Simple, everyday language.
Preferred response language: Russian (Русский)

## System Architecture

### Frontend
- **Framework**: React with TypeScript, Vite, shadcn/ui (new-york style), Radix UI, and Tailwind CSS.
- **State Management**: TanStack React Query.
- **Routing**: `wouter`-based.
- **Theme**: Dark/light mode toggle.

### Backend
- **Runtime**: Node.js with `tsx` and Express.js.
- **File Processing**: FFmpeg operations are delegated to a RunPod GPU pod (replaces old VPS 164.92.89.90).
- **File Storage**: Dual mode (local filesystem or direct pod upload) controlled by `LOCAL_PROCESSING` environment variable.
- **AI Pipeline**:
    - **Highlight Detection**: GPT (`gpt-4.1-mini`) uses a two-pass system:
        - **Pass 1 (Scan)**: Higher temperature (0.5-0.7) for rough timestamp detection.
        - **Pass 2 (Refine)**: Lower temperature (0.2) for precise start/end boundaries with context.
    - **Transcription**: RunPod faster-whisper endpoint (large-v3) for transcription with word-level timings. OpenAI API is used for re-transcription of clips on the VPS.
- **Export Pipeline**: VPS runs FFmpeg for export (cropping, stacking, subtitles, bleeping), supporting 9:16 vertical (default) and 1:1 square aspect ratios.
- **Data Layer**: PostgreSQL with Drizzle ORM. External **Neon.tech** database (`NEON_DATABASE_URL`) — accessible from anywhere (RunPod, Replit Deploy, etc.). Replit-internal `DATABASE_URL` used as dev fallback only.
- **Key Design Patterns**:
    - **Shared types**: `shared/schema.ts` for Drizzle, Zod validation, and TypeScript.
    - **Calibration system**: User-defined crop boxes for regions (table, webcam, chat).
    - **Video Filters**: 10 named FFmpeg filters (`sharpen`, `warm`, `cool`, `vibrant`, `cinematic`, `vintage`, `hdr`, `bw`, `soft`, `dramatic`).
    - **Background audio overlay**: Mixing and looping background music with volume control and a "music drop" feature for dynamic volume increases.
    - **Caption position**: Adjustable vertical position (30-95%) for ASS subtitles.
    - **Streamer dual-region layout**: Two crops stacked as 50%/38% with 12% black padding.
    - **Dynamic camera system**: GPU-accelerated face detection generates camera keyframes for dynamic webcam crop within streamer content. Detection chain: **RunPod YOLO GPU** → VPS YOLO/DNN → GPT-4o Vision → MediaPipe. Kalman filter smooths jitter between keyframes. Uses FFmpeg expression-based interpolation for smooth transitions. Toggled via `enableDynamicCamera` checkbox (streamer content only). Module: `server/ai-camera.ts`.
    - **RunPod YOLO endpoint**: `/analyze-faces` in `pod-server.py` on pod `jlozmxn8xfcjae`. Model: `yolov8n-face.pt` (6.2MB, HuggingFace `arnabdhar/YOLOv8-Face-Detection`). Auth: `Authorization: Bearer VPS_TOKEN`. Lazy-loaded on first request, GPU-warmed. Receives frame URLs from VPS (`POST /frame/:videoId`), downloads them, runs YOLO inference on RTX A4000 GPU.

### Subtitle System
- **Caption styles**: `mrbeast` (Komika Title, karaoke highlighting), `glow` (Bebas Neue Cyrillic, vertical gradient, rotating colors), `standard` (Inter, karaoke style).
- **Features**: Adjustable vertical position, audio mix control, profanity bleeping (40ms before/80ms after, custom bleep sound).
- **ASS generation**: VPS `server.js` handles generation, breaking segments into 3-word phrases and using real word timings.

### AI Коррекция транскрипции (кнопка "AI коррекция")
- **Кнопка**: только в редакторе обычных AI-клипов (`ClipEditorDialog`). В авто-нарезке её нет.
- **Маршрут**: `POST /api/videos/:id/correct-clip` с `{ startTime, endTime }` клипа.
- **Поток**:
    1. Сервер → VPS HTTP `POST /transcribe/clip/:vpsVideoId` — FFmpeg вырезает аудио нужного участка, отправляет в OpenAI **whisper-1**.
    2. VPS возвращает исправленный текст + тайм-коды слов.
    3. Сервер сопоставляет слова с существующими тайм-кодами через алгоритм «якорей» (`correctClipTranscriptWithAI` в `server/ai-pipeline.ts`).
    4. GPT-4.1-mini разбивает результат на фразы-субтитры.
    5. Сохраняет обновлённые сегменты в БД → тост «AI коррекция: N сегм. исправлено».
- **Требования**: VPS доступен по HTTP, `OPENAI_API_KEY` задан в PM2 на VPS, `video.vpsVideoId` заполнен.
- **При ошибке**: красный тост с текстом ошибки.
- **Авто-нарезка**: Whisper коррекция запускается **автоматически** для каждого клипа перед рендером (progress 10%). Исправленные сегменты используются для субтитров и сохраняются обратно в видео. Если VPS недоступен — используется оригинальная транскрипция без прерывания рендера.
- **Авто-нарезка использует `gpt-4o-mini-transcribe`**: VPS вырезает аудио клипа (`/audio/clip/:videoId`) и возвращает байты → Replit отправляет в OpenAI `gpt-4o-mini-transcribe` напрямую (та же модель что в основном пайплайне). Функция: `correctClipWithGpt4oTranscribe` в `server/ai-pipeline.ts`.
- **Перерендер авто-клипа**: кнопка (иконка ↺) на карточке completed/error авто-клипа сбрасывает его в queued и запускает повторный рендер с новой Whisper коррекцией. Эндпоинт: `POST /api/auto-cuts/:id/rerender`.
- **Пропуск удалённых клипов**: рендер-цикл авто-нарезки проверяет существование клипа в БД ПЕРЕД началом рендера и пропускает удалённые клипы (не только после завершения рендера).

### Bleep (Profanity Censor) Sounds
- **Active bleep**: `server/assets/bleep_quack.mp3` → deployed to `/opt/poker-shorts-vps/bleep_quack.mp3` on VPS **and RunPod** (same path on both servers).
- **VPS filter**: `buildBleepFilter()` in `vps-server/server.js` uses `amovie=/opt/poker-shorts-vps/bleep_quack.mp3:loop=999` to loop/trim the file to the exact bleep duration.
- **Available sound files** (in `attached_assets/`):
  - `002_33428_(1)_1773961618321.mp3` — 4.6 KB (same as current active bleep)
  - `animal_bird_duck_quack_003_1773930772986.mp3` — 6.8 KB (alternative duck quack, longer)
- **Background music files** (in `attached_assets/`):
  - `paulyudin-sad-sad-music-485935_1773626425246.mp3` — 4 MB
  - `syml-wheres-my-love-alternative-version-lyrics_1773622022515.mp3` — 3.6 MB
- To switch bleep sound: copy new file to `server/assets/bleep_quack.mp3`, run `scp` to VPS `/opt/poker-shorts-vps/bleep_quack.mp3`, restart PM2.

## Channel Configurations

### Злой (Postmypost Profile ID: `b2feb8fe`)
- **YouTube**: ZLOY Shorts
- **Postmypost**: ZLOY FUNPAGE
- **TikTok**: @zloyfanpage
- **Instagram**: @funzloy
- **Facebook**: подключён
- **Threads**: не настроен
- **Default BGM**: `Zloy_Moments_BGM`, Volume: 10%
- **Caption**: Whisper, Y: 50%

### CuteSkeleton (Postmypost Profile ID: `2a99718d`)
- *(конфиг не задокументирован)*

### Мелстрой (Postmypost Profile ID: `e13e80a3-f6ad-4bbb-9397-467a2fa2b540`)
- **Webcam region**: `{"x":953,"y":0,"width":603,"height":1072}` (без стола)
- *(соцсети не задокументированы)*

## External Dependencies

- **PostgreSQL**: Primary database.
- **FFmpeg/FFprobe**: For all video and audio processing.
- **RunPod GPU Pod (`gbyl00lvgug80g`, RTX A4000)**:
    - Replaces old VPS 164.92.89.90 entirely.
    - Node.js server: `https://gbyl00lvgug80g-8787.proxy.runpod.net` (env: `VPS_URL`)
    - Python GPU server: `https://gbyl00lvgug80g-8788.proxy.runpod.net` (env: `RUNPOD_POD_URL`)
    - SSH: IP 38.80.152.248, port changes on pod restart — use `VPS_SSH_KEY` private key.
    - Docker image: `yspehpulse/poker-shorts-runpod:latest` (auto-built via GitHub Actions on push to `LILSUFFER/poker-shorts-runpod`).
    - On code change: GitHub Actions `deploy.yml` restarts the pod → startup script pulls latest code.
    - On Dockerfile change: GitHub Actions `build.yml` rebuilds image → then restart pod manually.
    - GPU Endpoints for WhisperX (transcription + alignment) and Faster-Whisper (fast transcription).
- **OpenAI API**: For GPT highlight detection and Whisper transcription.
- **YouTube Data API**: For YouTube Shorts upload via OAuth 2.0, including custom thumbnail setting.
- **AI Auto-Cut System**: Separate `auto_cuts` table for fully automated clip generation. Takes highlights, creates records in own table (not touching regular clips), renders 9:16 videos with subtitles via GPU, with inline video playback. Endpoint: `POST /api/videos/:id/auto-cut`, CRUD: `/api/auto-cuts/*`. **Bleep** always enabled server-side (`bleepProfanity = true` hardcoded). **AI music selection**: if no track specified by user, GPT-4.1-mini picks from `/api/sounds` list based on content type + clip titles/tags before the render loop.
- **Clean Export System**: Auto-exports clean versions of published clips (no filters/subtitles/watermark) to `private_clean_exports/` for re-use on other channels.
- **Postmypost.io API**: For social media publishing (YouTube, TikTok, Instagram, Facebook, VK).
- **Google Gemini API**: For Imagen 4.0 and Veo.
- **Upload-Post.com API**: Legacy fallback for Instagram Reels and TikTok uploads.