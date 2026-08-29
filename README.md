# RH Stream backend

Xtream and M3U API for the RH Stream frontend and Roku channel. It provides
playlist source management, explicit Roku catalog selection, direct media
proxying, MongoDB playback history, and MongoDB favorites.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

The default API address is `http://0.0.0.0:8787`. Check `GET /api/health`.

## Media resource controls

FFmpeg jobs are bounded by `MAX_TOTAL_FFMPEG_JOBS`, `MAX_ACTIVE_REMUX_JOBS`,
`MAX_ACTIVE_TRANSCODES`, `MAX_JOBS_PER_USER`, and `MAX_JOBS_PER_DEVICE`.
`MEDIA_JOB_IDLE_TIMEOUT_MS` controls abandoned HLS cleanup. Direct proxy
streams do not consume FFmpeg capacity and preserve byte-range requests.

Set `INTERNAL_DIAGNOSTICS_TOKEN` to enable `GET /internal/media-health`, then
send the token in `x-internal-token`. The endpoint never includes provider URLs
or credentials.

Run lifecycle tests with `npm test`. A provider-backed play/stop leak test is
available with:

```bash
MEDIA_TEST_TOKEN=... \
MEDIA_DEVICE_TOKEN=... \
MEDIA_TEST_PLAYBACK_PATH='/api/xtream/hls/.../master.m3u8' \
npm run test:media-leak
```

## Render

The repository includes `render.yaml` and a Dockerfile. Configure
`MONGODB_URI` as a Render secret. Never commit `.env` or provider credentials.
