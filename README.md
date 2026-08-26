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

## Cloudflare R2 + Stream movies

For movies larger than 300 MB, configure the Cloudflare variables in
`.env.example`: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_STREAM_API_TOKEN`,
`CLOUDFLARE_STREAM_HOST`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET`, `R2_ENDPOINT`, and `R2_PUBLIC_BASE_URL`.

The R2 bucket must be readable through a public custom domain so Stream can
import the object by URL. Configure the browser CORS rule through the
S3-compatible API after setting `R2_CORS_ORIGINS`:

```bash
npm run configure:r2-cors
```

The frontend uploads the movie directly to R2 in 100 MiB multipart parts,
then Stream imports the completed object and produces an HLS manifest for Roku
and the browser. This bypasses the Cloudflare dashboard's 300 MB upload path.
