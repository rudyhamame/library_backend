import { createHash } from 'node:crypto';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MongoClient } from 'mongodb';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const streamToken = process.env.CLOUDFLARE_STREAM_API_TOKEN || '';
const bucket = process.env.R2_BUCKET || '';
const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');
const r2 = accountId && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  ? new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } })
  : null;
let mongoPromise;
function configured() { return Boolean(r2 && bucket && publicBaseUrl && accountId && streamToken); }
function requireConfigured() { if (!configured()) throw new Error('Cloudflare R2/Stream is not configured on the backend'); }
async function collection() {
  if (!mongoPromise) mongoPromise = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017').connect().then(client => client.db(process.env.MONGODB_DB || 'rh_stream').collection('cloud_movies'));
  return mongoPromise;
}
function keyFor(name) {
  const safe = String(name || 'movie').replace(/[^\w .()\-\u0600-\u06FF]/g, '_').trim() || 'movie';
  return `${process.env.R2_KEY_PREFIX || 'movies'}/${Date.now()}-${safe}`;
}
function publicUrl(key) { return `${publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`; }
export function cloudMediaConfigured() { return configured(); }
export async function createMultipart({ filename, contentType, size }) {
  requireConfigured();
  const partSize = 100 * 1024 * 1024;
  const partCount = Math.ceil(Number(size) / partSize);
  if (!Number.isFinite(partCount) || partCount < 1 || partCount > 10000) throw new Error('Invalid movie size');
  const key = keyFor(filename);
  const result = await r2.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType || 'video/x-matroska', Metadata: { title: String(filename || '') } }));
  const parts = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    parts.push({ partNumber, url: await getSignedUrl(r2, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: result.UploadId, PartNumber: partNumber }), { expiresIn: 3600 }) });
  }
  return { uploadId: result.UploadId, key, partSize, partCount, parts };
}
export async function completeMultipart({ key, uploadId, parts }) {
  requireConfigured();
  const result = await r2.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts.map(part => ({ PartNumber: Number(part.partNumber), ETag: part.etag })) } }));
  return { key, sourceUrl: publicUrl(key), etag: result.ETag || '' };
}
export async function abortMultipart({ key, uploadId }) {
  requireConfigured();
  await r2.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}
export async function importToStream({ sourceUrl, title, key }) {
  requireConfigured();
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`, { method: 'POST', headers: { Authorization: `Bearer ${streamToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ url: sourceUrl, meta: { name: String(title || key || 'Movie') } }) });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.errors?.map(error => error.message).join('; ') || `Cloudflare Stream returned HTTP ${response.status}`);
  const result = body.result;
  const id = `cloud-${createHash('sha1').update(String(result.uid)).digest('hex').slice(0, 20)}`;
  const streamHost = (process.env.CLOUDFLARE_STREAM_HOST || '').replace(/\/$/, '');
  const movie = { _id: id, id, title: String(title || key || 'Movie'), source: 'cloudflare-stream', r2Key: key || '', streamUid: result.uid, status: result.readyToStream ? 'ready' : 'processing', playbackUrl: result.playback?.hls || (streamHost ? `${streamHost}/${result.uid}/manifest/video.m3u8` : ''), thumbnail: result.thumbnail || '', updatedAt: new Date() };
  await (await collection()).updateOne({ _id: id }, { $set: movie, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  return movie;
}
export async function listCloudMovies() { return (await (await collection()).find({}).sort({ updatedAt: -1 }).toArray()).map(({ _id, ...movie }) => movie); }
export async function refreshCloudMovie(id) {
  requireConfigured();
  const movie = (await listCloudMovies()).find(item => item.id === id);
  if (!movie) return null;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${movie.streamUid}`, { headers: { Authorization: `Bearer ${streamToken}` } });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error('Could not check Cloudflare Stream status');
  const result = body.result;
  const updated = { ...movie, status: result.readyToStream ? 'ready' : (result.status?.state || 'processing'), playbackUrl: result.playback?.hls || movie.playbackUrl, thumbnail: result.thumbnail || movie.thumbnail, duration: result.duration || 0, updatedAt: new Date() };
  await (await collection()).updateOne({ _id: id }, { $set: updated });
  return updated;
}
