# RH Library backend

Independent Xtream and M3U API for the RH Library web, Android, and iPad
clients. It provides playlist management, catalog browsing, library selection,
accounts, device pairing, weather, MongoDB playback history, and MongoDB
favorites. It is also the Roku control plane. Media-delivery routes
(`/api/xtream/play`, `/api/xtream/hls`, and `/api/xtream/roku`) deliberately
return `404`; Roku playback is served only by `roku_backend`.
Library-managed rail categories are stored in the `library_categories`
collection by default. Playlist categories seed this collection, while names,
deletions, and item membership are controlled through the Library UI and are
the source of truth for Roku.

This service intentionally uses the same MongoDB database, collection names,
and `DEVICE_AUTH_SECRET` as the Roku Streamer backend. Every platform token is
resolved to the same canonical account owner. Playlist sources and selections,
categories, playback history and resume positions, favorites, and weather are
account-scoped; linked device profiles retain pairing and presence state only.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

The default API address is `http://0.0.0.0:8787`. Check `GET /api/health`.

Run `npm test` to verify both application behavior and the rule that this
service never delivers streaming media.

## Self-hosted deployment

This service runs on the local machine only, managed by the systemd units in
`../deploy/` and exposed to clients over the Tailscale network. Set
`MONGODB_URI`, `DEVICE_AUTH_SECRET`, `PUBLIC_BASE_URL`, and `FRONTEND_URL` in
`.env` (see `.env.example`); use the same secret values as the Roku backend.
Never commit `.env` or provider credentials.
