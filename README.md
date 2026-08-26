# RH Stream backend

Xtream-only API for the RH Stream frontend and Roku channel. It provides
Xtream source management, explicit Roku catalog selection, direct media
proxying, MongoDB playback history, and MongoDB favorites.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

The default API address is `http://0.0.0.0:8787`. Check `GET /api/health`.

## Render

The repository includes `render.yaml` and a Dockerfile. Configure
`MONGODB_URI` as a Render secret. Never commit `.env` or provider credentials.
