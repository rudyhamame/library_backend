# RH Stream backend

Backend API for the RH Stream frontend and Roku application. It provides the
Telegram catalog, HLS preparation through FFmpeg, IPTV sources, playback
history, local movie management, and MongoDB-backed playlists.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

The API listens on `0.0.0.0:8787` by default. Check it with:

```text
GET /api/health
```

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Frudyhamame%2Fstream_back)

The repository includes `render.yaml` and a Docker image with FFmpeg. Create a
Render Blueprint from this repository and provide the secret environment
variables requested by the Blueprint. Never commit `.env`, Telegram session
files, local movies, or generated HLS/cache files.

Local movie files are intentionally excluded from the Render image. Use the
LAN deployment for server-local movies, or attach suitable persistent/cloud
storage before enabling that feature on Render.
