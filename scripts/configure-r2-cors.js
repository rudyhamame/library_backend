import 'dotenv/config';
import { PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const bucket = process.env.R2_BUCKET || '';
const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
const origins = (process.env.R2_CORS_ORIGINS || process.env.PUBLIC_BASE_URL || 'http://localhost:5173')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
  throw new Error('Set CLOUDFLARE_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY first');
}

const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
});

await client.send(new PutBucketCorsCommand({
  Bucket: bucket,
  CORSConfiguration: {
    CORSRules: [{
      AllowedOrigins: origins,
      AllowedMethods: ['PUT', 'GET', 'HEAD'],
      AllowedHeaders: ['Content-Type'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    }],
  },
}));

console.log(`Configured R2 CORS for ${bucket}: ${origins.join(', ')}`);
