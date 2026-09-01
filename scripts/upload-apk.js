import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { request } from 'node:https';
import { basename, resolve } from 'node:path';

const filePath = resolve(process.argv[2] || '');
const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;
const publicId = process.env.ANDROID_APP_PUBLIC_ID || 'RH IPTV Library.apk';

if (!process.argv[2]) throw new Error('Usage: node scripts/upload-apk.js <apk-path>');
if (!cloudName || !apiKey || !apiSecret) throw new Error('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required');
if (basename(filePath).toLowerCase() !== 'app-debug.apk') throw new Error('Only the debug APK may be published by this task');
const file = statSync(filePath);
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHash('sha1').update(`overwrite=true&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`).digest('hex');
const boundary = `----RHCloudinary${Date.now()}`;
const fields = { api_key: apiKey, timestamp: String(timestamp), signature, public_id: publicId, overwrite: 'true' };
const chunks = [];
for (const [key, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${basename(filePath)}"\r\nContent-Type: application/vnd.android.package-archive\r\n\r\n`));
const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
const contentLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + file.size + tail.length;

await new Promise((resolvePromise, reject) => {
  const req = request({ hostname: 'api.cloudinary.com', path: `/v1_1/${encodeURIComponent(cloudName)}/raw/upload`, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': contentLength } }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Cloudinary upload failed (${res.statusCode}): ${body.slice(0, 500)}`));
      let result;
      try { result = JSON.parse(body); } catch { return reject(new Error('Cloudinary returned invalid JSON')); }
      console.log(`Uploaded ${basename(filePath)} as ${result.public_id} (${result.bytes} bytes)`);
      resolvePromise();
    });
  });
  req.on('error', reject);
  for (const chunk of chunks) req.write(chunk);
  createReadStream(filePath).on('error', reject).on('end', () => req.end(tail)).pipe(req, { end: false });
});
