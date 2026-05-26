# 🎵 Audio Converter — MAINUL-X

A full-stack video-to-audio converter web app built with **Node.js + Express**.  
Supports YouTube URLs and local video file uploads.  
Real-time progress bar via **SSE (Server-Sent Events)**.

---

## Features

- 🔗 YouTube URL → Audio (MP3, M4A, FLAC, WAV, OGG)
- 📁 Local video file upload → Audio conversion
- 📊 **Real-time progress bar** (actual % from yt-dlp, not fake animation)
- 🎵 In-browser audio player after conversion
- 🖼️ Thumbnail embed (MP3 / M4A)
- 📜 Download history
- 🌐 Deployed on Render (Docker)

---

## Tech Stack

| Layer    | Tech                        |
|----------|-----------------------------|
| Backend  | Node.js, Express            |
| Download | yt-dlp (via python3 -m)     |
| Convert  | ffmpeg                      |
| Progress | SSE (Server-Sent Events)    |
| Frontend | Vanilla JS, HTML/CSS        |
| Hosting  | Render (Docker, free tier)  |

---

## Project Structure

```
audio-converter/
├── server.js          # Express API server
├── package.json
├── Dockerfile
├── render.yaml
└── public/
    └── index.html     # Frontend UI
```

---

## API Endpoints

| Method | Endpoint                  | Description                        |
|--------|---------------------------|------------------------------------|
| GET    | `/api/health`             | Health check                       |
| GET    | `/api/preview?url=`       | Fetch video metadata               |
| GET    | `/api/convert-stream`     | Convert URL → audio (SSE progress) |
| POST   | `/api/convert`            | Convert URL → audio (no stream)    |
| POST   | `/api/convert-file`       | Upload video file → audio          |
| GET    | `/api/download/:filename` | Download converted file            |

### SSE Events (`/api/convert-stream`)

| Event  | Data                                              |
|--------|---------------------------------------------------|
| `meta` | `{ title, duration, thumbnail }`                  |
| `prog` | `{ pct, phase, label, speed, eta, size }`         |
| `done` | `{ downloadUrl, title, duration, thumbnail, filesize }` |
| `error`| `{ message }`                                     |

---

## Environment Variables

| Variable     | Description                        | Required |
|--------------|------------------------------------|----------|
| `PORT`       | Server port (default: 3000)        | No       |
| `YT_COOKIES` | YouTube cookies (Netscape format)  | No       |

---

## Deploy on Render

1. Push project to GitHub
2. New Web Service → **Docker** runtime
3. Set `YT_COOKIES` env var if needed (for age-restricted videos)
4. Deploy ✅

---

## Local Development

```bash
npm install
node server.js
# Open http://localhost:3000
```

**Requirements:** `python3`, `yt-dlp`, `ffmpeg` must be installed locally.

---

## Contact

- Telegram: [@mdmainulislaminfo](https://t.me/mdmainulislaminfo)
- GitHub: [M41NUL](https://github.com/M41NUL)
- Channel: [@mainul_x_official](https://t.me/mainul_x_official)
