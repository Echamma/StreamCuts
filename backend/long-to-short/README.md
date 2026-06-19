# Long to Short Backend

NestJS backend for the custom OpenCut `Long to Short` tab.

## What it does

- Accepts a video upload from the frontend
- Uses Gemini to choose the strongest clips, including count and duration
- Generates TikTok-ready title and description copy for each clip
- Accepts timeline audio uploads for caption transcription
- Runs Python `faster-whisper` for backend caption generation
- Returns download URLs for the rendered clips

When Gemini planning is unavailable, the backend falls back to an automatic sequential planner. It replaces the previous standalone transcription script with a backend the frontend can actually call.

## Run

```bash
npm install
npm run start:dev
```

The backend starts on `http://localhost:4000` by default.

To enable backend captions, install the Python dependency in the Python environment that `PYTHON_BIN` points to:

```bash
python -m pip install -r python/requirements.txt
```

## Environment

- `PORT`: backend port, default `4000`
- `FRONTEND_ORIGIN`: allowed CORS origin, default local hosts
- `PYTHON_BIN`: Python executable for transcription, default `python`
- `FASTER_WHISPER_MODEL`: Whisper model name, default `medium` (use `small` for faster/lighter transcription, `large-v3` for best accuracy)
- `FASTER_WHISPER_BEAM_SIZE`: decoding beam width, default `5` (higher = more accurate, slower)
- `FASTER_WHISPER_DEVICE`: whisper device, default `cpu`
- `FASTER_WHISPER_COMPUTE_TYPE`: whisper compute type, default `int8`
- `FASTER_WHISPER_DOWNLOAD_ROOT`: optional directory for the shared Faster-Whisper model cache
- `GEMINI_API_KEY`: optional Google Gemini API key for TikTok copy generation
- `GEMINI_MODEL`: optional Gemini model, default `gemini-3.5-flash`

## Transcription worker

The backend keeps a warm Python `faster-whisper` worker process alive and reuses it
for every `POST /api/transcription/transcribe` request. That means captions and any
other backend transcription feature share the same loaded model instead of reloading
it for every request.

## API

`POST /api/long-to-short/process`

Multipart form data:

- `video`: uploaded video file
- `targetClipSizeMb`: optional positive number

`GET /api/long-to-short/jobs/:jobId/clips/:clipName`

Downloads a rendered clip.

When `GEMINI_API_KEY` is set, the `process` response also includes Gemini-generated
TikTok copy per clip. If Gemini or transcription is unavailable, the backend falls
back to generic copy so clip generation still completes.

`POST /api/transcription/transcribe`

Multipart form data:

- `audio`: audio or video upload
- `language`: optional language code, omit for auto detect
