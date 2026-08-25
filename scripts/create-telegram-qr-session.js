import 'dotenv/config';
import qrcode from 'qrcode-terminal';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || '';
if (!apiId || !apiHash) throw new Error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in backend/.env first.');

const prompt = createInterface({ input, output });
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

try {
  await client.connect();
  console.log('Open Telegram on your phone and choose Settings → Devices → Link Desktop Device.');
  await client.signInUserWithQrCode({ apiId, apiHash }, {
    qrCode: async ({ token }) => {
      console.clear();
      console.log('Scan this QR code in Telegram:');
      qrcode.generate(`tg://login?token=${token.toString('base64url')}`, { small: true });
    },
    password: async () => prompt.question('Telegram 2FA password: '),
    onError: async (error) => { console.error(`QR login failed: ${error.message}`); return true; }
  });
  console.log('\nCopy this complete line into Render as TELEGRAM_SESSION:');
  console.log(client.session.save());
} finally {
  prompt.close();
  await client.disconnect();
}
