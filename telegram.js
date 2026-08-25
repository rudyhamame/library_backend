import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import bigInt from 'big-integer';

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || '';
const moduleDir = dirname(fileURLToPath(import.meta.url));
const sessionFile = resolve(moduleDir, process.env.TELEGRAM_SESSION_FILE || '.telegram-session');
function normalizeChannel(value) {
  return value.trim()
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
}

const configuredChannels = (process.env.TELEGRAM_CHANNELS || '')
  .split(',').map(normalizeChannel).filter(Boolean);

let clientPromise;
let authState = null;
let dialogChannels = [];
const thumbnailCache = new Map();
const videoCache = new Map();
const catalogCache = new Map();
const catalogRequests = new Map();
const maxConcurrentDownloads = Math.max(2, Number.parseInt(process.env.TELEGRAM_MAX_STREAMS || '2', 10) || 2);
let activeDownloads = 0;
const downloadWaiters = [];

async function acquireDownloadSlot() {
  if (activeDownloads < maxConcurrentDownloads) { activeDownloads += 1; return; }
  await new Promise(resolve => downloadWaiters.push(resolve));
}

function releaseDownloadSlot() {
  const next = downloadWaiters.shift();
  if (next) next();
  else activeDownloads = Math.max(0, activeDownloads - 1);
}

async function savedSession() {
  if (process.env.TELEGRAM_SESSION?.trim()) return process.env.TELEGRAM_SESSION.trim();
  try { return (await readFile(sessionFile, 'utf8')).trim(); } catch { return ''; }
}

export async function telegramStatus() {
  let restoreError = null;
  if (!clientPromise && !authState) {
    try { await getClient(); } catch (error) { restoreError = error.message; }
  }
  if (clientPromise) {
    try { dialogChannels = await getTelegramChannels(await clientPromise); } catch (error) { restoreError = error.message; }
  }
  return {
    configured: Boolean(apiId && apiHash),
    authenticated: Boolean(clientPromise),
    channels: dialogChannels,
    authPending: Boolean(authState),
    authStep: authState?.passwordResolve ? 'password' : authState ? 'code' : null,
    restoreError,
    playback: 'metadata-only until authorized media hosting is configured'
  };
}

async function getTelegramChannels(client) {
  const channels = [];
  const seen = new Set();
  for await (const dialog of client.iterDialogs({})) {
    if (!dialog.isChannel || dialog.entity?.broadcast === false || seen.has(String(dialog.entity.id))) continue;
    seen.add(String(dialog.entity.id));
    channels.push({
      id: String(dialog.entity.id),
      name: dialog.title || dialog.entity.title || 'Untitled channel',
      username: dialog.entity.username ? `@${dialog.entity.username}` : null,
      value: dialog.entity.username || String(dialog.entity.id)
    });
  }
  return channels;
}

async function getClient() {
  const session = await savedSession();
  if (!apiId || !apiHash || !session) return null;
  if (!clientPromise) {
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 });
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

export async function beginTelegramAuth(phone) {
  if (!apiId || !apiHash) throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required in backend/.env');
  if (authState) throw new Error('Telegram authentication is already in progress');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  const state = { phone, codeResolve: null, passwordResolve: null };
  authState = state;
  state.promise = client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => new Promise(resolve => { state.codeResolve = resolve; }),
    password: async () => new Promise(resolve => { state.passwordResolve = resolve; }),
    onError: error => { state.error = error; }
  }).then(async () => {
    await writeFile(sessionFile, client.session.save(), { mode: 0o600 });
    clientPromise = Promise.resolve(client);
    return true;
  }).finally(() => { authState = null; });
  return { sent: true };
}

export function submitTelegramCode(code) {
  if (!authState?.codeResolve) throw new Error('No Telegram code is currently requested');
  authState.codeResolve(code);
  return { submitted: true };
}

export function submitTelegramPassword(password) {
  if (!authState?.passwordResolve) throw new Error('No Telegram 2FA password is currently requested');
  authState.passwordResolve(password);
  return { submitted: true };
}

async function fetchTelegramCatalog(channel, page = 1, pageSize = 10) {
  const client = await getClient();
  if (!client) return { configured: false, items: [], totalPages: 0 };
  const normalizedChannel = normalizeChannel(channel);
  let entity;
  try {
    entity = await client.getEntity(normalizedChannel);
  } catch (error) {
    if (error.errorMessage === 'USERNAME_INVALID' || error.message?.includes('USERNAME_INVALID')) {
      throw new Error(`Telegram cannot resolve "${normalizedChannel}". Use the exact public username without spaces, or use a channel your account has joined/admin access to.`);
    }
    throw error;
  }
  const offset = Math.max(0, (page - 1) * pageSize);
  const items = [];
  // Ask Telegram for video messages directly. Filtering after fetching ordinary
  // history caused pages to contain fewer videos whenever text/photos were
  // mixed into the channel, which made Load more skip or repeat entries.
  const messages = client.iterMessages(entity, {
    limit: pageSize,
    addOffset: offset,
    filter: new Api.InputMessagesFilterVideo(),
    waitTime: 0
  });
  for await (const message of messages) {
    const media = message.video || (message.document?.mimeType?.startsWith('video/') ? message.document : null);
    if (!media) continue;
    items.push({
      id: `${channel}:${message.id}`,
      title: (message.message || `Telegram video ${message.id}`).split('\n')[0].trim(),
      duration: formatDuration(getVideoDuration(media)),
      thumbnail: `/api/telegram/thumbnail?channel=${encodeURIComponent(normalizedChannel)}&message=${message.id}&v=2`,
      playbackUrl: `/api/telegram/video?channel=${encodeURIComponent(normalizedChannel)}&message=${message.id}`,
      telegramMessageId: message.id,
      source: 'telegram',
      metadata: extractMetadata(message, media, normalizedChannel)
    });
  }
  const total = Number(messages.total || offset + items.length);
  return { configured: true, items, totalPages: Math.ceil(total / pageSize) };
}

export async function getTelegramCatalog(channel, page = 1, pageSize = 10) {
  const key = `${normalizeChannel(channel)}:${page}:${pageSize}`;
  const cached = catalogCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (catalogRequests.has(key)) return catalogRequests.get(key);
  const request = fetchTelegramCatalog(channel, page, pageSize).then(value => {
    catalogCache.set(key, { value, expires: Date.now() + 30_000 });
    return value;
  }).finally(() => catalogRequests.delete(key));
  catalogRequests.set(key, request);
  return request;
}

export async function getAllTelegramCatalog(channel, chunkSize = 100) {
  const key = `all:${normalizeChannel(channel)}`;
  const cached = catalogCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (catalogRequests.has(key)) return catalogRequests.get(key);
  // One iterator avoids repeatedly rescanning the channel for every page.
  // The Telegram iterator stops naturally when the channel history is exhausted.
  const request = fetchTelegramCatalog(channel, 1, 100000).then(result => {
    const value = { configured: result.configured, items: result.items, totalPages: 1 };
    catalogCache.set(key, { value, expires: Date.now() + 30_000 });
    return value;
  }).finally(() => catalogRequests.delete(key));
  catalogRequests.set(key, request);
  return request;
}

function getVideoDuration(media) {
  if (media.duration) return Number(media.duration);
  const attributes = media.document?.attributes || media.attributes || [];
  const video = attributes.find(attribute => attribute.className === 'DocumentAttributeVideo');
  return video?.duration ? Number(video.duration) : null;
}

function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const value = Math.round(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function extractMetadata(message, media, channel) {
  const document = media.document || media;
  const attributes = document.attributes || [];
  const fileAttribute = attributes.find(attribute => attribute.className === 'DocumentAttributeFilename');
  const videoAttribute = attributes.find(attribute => attribute.className === 'DocumentAttributeVideo');
  return {
    channel,
    messageId: message.id,
    caption: message.message || '',
    date: message.date ? new Date(message.date * 1000).toISOString() : null,
    editedAt: message.editDate ? new Date(message.editDate * 1000).toISOString() : null,
    views: message.views ?? null,
    forwards: message.forwards ?? null,
    replies: message.replies?.replies ?? null,
    groupedId: message.groupedId ? String(message.groupedId) : null,
    pinned: Boolean(message.pinned),
    postAuthor: message.postAuthor || null,
    mediaType: message.video ? 'video' : document.mimeType || 'document',
    fileName: fileAttribute?.fileName || null,
    mimeType: document.mimeType || null,
    sizeBytes: document.size ? Number(document.size) : null,
    width: videoAttribute?.w ?? media.w ?? null,
    height: videoAttribute?.h ?? media.h ?? null,
    durationSeconds: videoAttribute?.duration ?? media.duration ?? null,
    performer: attributes.find(attribute => attribute.className === 'DocumentAttributeAudio')?.performer || null,
    mediaTitle: attributes.find(attribute => attribute.className === 'DocumentAttributeAudio')?.title || null,
    supportsStreaming: videoAttribute?.supportsStreaming ?? null,
    hasThumbnail: Boolean(document.thumbs?.length || media.photo)
  };
}

export async function getTelegramThumbnail(channel, messageId) {
  const client = await getClient();
  if (!client) throw new Error('Telegram is not authenticated');
  const normalizedChannel = normalizeChannel(channel);
  const id = Number.parseInt(messageId, 10);
  if (!normalizedChannel || !Number.isInteger(id)) throw new Error('Invalid channel or message');
  const cacheKey = `v2:${normalizedChannel}:${id}`;
  if (thumbnailCache.has(cacheKey)) return thumbnailCache.get(cacheKey);
  const entity = await client.getEntity(normalizedChannel);
  const messages = await client.getMessages(entity, { ids: [id] });
  const message = messages[0];
  if (!message?.media) return null;
  // Telegram stores multiple thumbnail sizes. GramJS sorts them from smallest
  // to largest, so index 0 is the low-resolution thumbnail. Select the largest
  // available photo/video thumb without downloading the full video.
  const document = message.video?.document || message.video || message.document?.document || message.document;
  const thumbs = [...(document?.thumbs || []), ...(document?.videoThumbs || [])];
  const largestThumb = thumbs.reduce((largest, current) => {
    if (!largest) return current;
    return thumbnailScore(current) > thumbnailScore(largest) ? current : largest;
  }, null);
  const data = largestThumb ? await client.downloadMedia(message, { thumb: largestThumb }) : null;
  if (!data) return null;
  const result = { type: 'image/jpeg', data: Buffer.from(data) };
  thumbnailCache.set(cacheKey, result);
  return result;
}

function thumbnailScore(thumb) {
  if (thumb?.w && thumb?.h) return Number(thumb.w) * Number(thumb.h);
  if (Array.isArray(thumb?.sizes) && thumb.sizes.length) return Math.max(...thumb.sizes.map(Number));
  if (thumb?.size) return Number(thumb.size);
  if (thumb?.bytes) return thumb.bytes.length;
  return 0;
}

export async function getTelegramVideo(channel, messageId) {
  const client = await getClient();
  if (!client) throw new Error('Telegram is not authenticated');
  const normalizedChannel = normalizeChannel(channel);
  const id = Number.parseInt(messageId, 10);
  if (!normalizedChannel || !Number.isInteger(id)) throw new Error('Invalid channel or message');
  const cacheKey = `${normalizedChannel}:${id}`;
  if (videoCache.has(cacheKey)) return videoCache.get(cacheKey);
  const entity = await client.getEntity(normalizedChannel);
  const messages = await client.getMessages(entity, { ids: [id] });
  const message = messages[0];
  if (!message?.video && !message?.document) return null;
  const document = message.video || message.document;
  const isVideo = message.video || document.mimeType?.startsWith('video/');
  if (!isVideo) return null;
  const buffer = await client.downloadMedia(message);
  if (!buffer) return null;
  const result = { type: document.mimeType || 'video/mp4', data: Buffer.from(buffer) };
  videoCache.set(cacheKey, result);
  return result;
}

export async function getTelegramVideoStream(channel, messageId, options = {}) {
  const client = await getClient();
  if (!client) throw new Error('Telegram is not authenticated');
  const normalizedChannel = normalizeChannel(channel);
  const id = Number.parseInt(messageId, 10);
  if (!normalizedChannel || !Number.isInteger(id)) throw new Error('Invalid channel or message');
  const entity = await client.getEntity(normalizedChannel);
  const messages = await client.getMessages(entity, { ids: [id] });
  const message = messages[0];
  if (!message?.video && !message?.document) return null;
  const document = message.video || message.document;
  if (!(message.video || document.mimeType?.startsWith('video/'))) return null;
  const requestSize = 512 * 1024;
  const byteOffset = Number.isInteger(options.offset) ? options.offset : 0;
  const byteLimit = Number.isInteger(options.limit) ? options.limit : undefined;
  // Telegram GetFile requires aligned direct reads. GramJS 2.26 can
  // incorrectly choose its direct iterator for offsets such as 48, which
  // returns an empty response to FFmpeg. A smaller chunk size forces its
  // alignment-safe generic iterator for those requests.
  const chunkSize = byteOffset % requestSize === 0 ? requestSize : 256 * 1024;
  const rawChunks = client.iterDownload({
    file: message.media,
    offset: bigInt(byteOffset),
    limit: byteLimit ? Math.ceil(byteLimit / chunkSize) : undefined,
    requestSize,
    chunkSize,
    stride: chunkSize
  });
  async function* chunks() {
    let remaining = byteLimit;
    await acquireDownloadSlot();
    try {
      for await (const chunk of rawChunks) {
        if (remaining === undefined) { yield chunk; continue; }
        if (remaining <= 0) break;
        yield chunk.subarray(0, remaining);
        remaining -= chunk.length;
      }
    } finally {
      releaseDownloadSlot();
    }
  }
  return {
    type: document.mimeType || 'video/mp4',
    size: document.size ? Number(document.size) : null,
    chunks: chunks()
  };
}

export function telegramMediaKey(channel, messageId) {
  return createHash('sha256').update(`${normalizeChannel(channel)}:${messageId}`).digest('hex').slice(0, 20);
}

export async function resolveTelegramChannel(value) {
  const client = await getClient();
  if (!client) throw new Error('Telegram is not authenticated');
  const normalized = normalizeChannel(value);
  if (!normalized) throw new Error('Enter a public Telegram username');
  try {
    const entity = await client.getEntity(normalized);
    if (!entity.broadcast && !entity.megagroup) throw new Error('That username is not a channel');
    return {
      id: String(entity.id),
      name: entity.title || normalized,
      username: entity.username ? `@${entity.username}` : `@${normalized}`,
      value: entity.username || normalized
    };
  } catch (error) {
    if (error.errorMessage === 'USERNAME_INVALID' || error.message?.includes('USERNAME_INVALID')) {
      throw new Error(`Telegram could not find "${normalized}". Check the public username.`);
    }
    throw error;
  }
}
