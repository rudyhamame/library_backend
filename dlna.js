import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, open } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import { getTelegramVideoStream } from './telegram.js';

export const dlnaRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'data/dlna');
const entries = new Map();
const cacheJobs = new Map();

export async function cacheForDlna(channel, messageId, title, onProgress = () => {}) {
  const id = createHash('sha1').update(`${channel}:${messageId}`).digest('hex').slice(0, 16);
  const filename = `${id}.mp4`;
  const path = resolve(dlnaRoot, filename);
  await mkdir(dlnaRoot, { recursive: true });
  try { await stat(path); entries.set(filename, { channel, messageId, title, filename }); return { filename, cached: true }; } catch {}
  const source = await getTelegramVideoStream(channel, messageId);
  if (!source) throw new Error('Telegram video was not found');
  const output = await open(path, 'w');
  let downloaded = 0;
  try {
    for await (const chunk of source.chunks) { await output.write(chunk); downloaded += chunk.length; onProgress(source.size ? Math.min(99, Math.round(downloaded / source.size * 100)) : null); }
  } catch (error) { await output.close(); await unlink(path).catch(() => {}); throw error; }
  await output.close();
  entries.set(filename, { channel, messageId, title, filename });
  return { filename, cached: false };
}

export function startDlnaCache(channel, messageId, title) {
  const id = createHash('sha1').update(`${channel}:${messageId}:${Date.now()}`).digest('hex').slice(0, 20);
  const job = { id, status: 'queued', progress: 0, filename: null, error: null };
  cacheJobs.set(id, job);
  cacheForDlna(channel, messageId, title, progress => { job.status = 'caching'; job.progress = progress; }).then(result => { job.status = 'complete'; job.progress = 100; job.filename = result.filename; }).catch(error => { job.status = 'error'; job.error = error.message; });
  return job;
}

export function getDlnaCacheJob(id) { return cacheJobs.get(id) || null; }

export async function listDlnaFiles() {
  await mkdir(dlnaRoot, { recursive: true });
  const files = (await readdir(dlnaRoot)).filter(file => extname(file).toLowerCase() === '.mp4');
  return files.map(filename => entries.get(filename) || { filename, title: filename });
}

export function dlnaDescription(origin) {
  return `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>Streaming Telegram Library</friendlyName><manufacturer>Local Streaming</manufacturer><modelName>Telegram DLNA</modelName><UDN>uuid:streaming-telegram-mediaserver</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><controlURL>/dlna/content</controlURL><eventSubURL>/dlna/events</eventSubURL><SCPDURL>/dlna/content.xml</SCPDURL></service></serviceList></device></root>`;
}

export async function dlnaBrowse(origin) {
  const files = await listDlnaFiles();
  const items = files.map((item, index) => `<item id="${index + 1}" parentID="0" restricted="1"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">${escapeXml(item.title)}</dc:title><upnp:class xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">object.item.videoItem</upnp:class><res protocolInfo="http-get:*:video/mp4:*" size="">${origin}/dlna/media/${item.filename}</res></item>`).join('');
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><container id="0" parentID="-1" restricted="1" childCount="${files.length}"><dc:title>Telegram Videos</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>${items}</DIDL-Lite>`;
}

function escapeXml(value) { return String(value).replace(/[<>&'\"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character])); }

export function startSsdp(port, address) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const location = `http://${address}:${port}/dlna/description.xml`;
  const announce = () => {
    const message = Buffer.from(`NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: ${location}\r\nNT: upnp:rootdevice\r\nNTS: ssdp:alive\r\nSERVER: Streaming/1.0 UPnP/1.0 TelegramDLNA/1.0\r\nUSN: uuid:streaming-telegram-mediaserver::upnp:rootdevice\r\n\r\n`);
    socket.send(message, 0, message.length, 1900, '239.255.255.250');
  };
  socket.on('message', (message, rinfo) => { if (message.toString().toUpperCase().includes('M-SEARCH')) announce(); });
  socket.bind(1900, () => { socket.addMembership('239.255.255.250'); announce(); });
  return socket;
}
