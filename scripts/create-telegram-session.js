import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || '';

if (!apiId || !apiHash) {
  throw new Error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in backend/.env first.');
}

const prompt = createInterface({ input, output });
const ask = (question) => prompt.question(question);
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

try {
  await client.start({
    phoneNumber: () => ask('Telegram phone number: '),
    phoneCode: () => ask('Telegram login code: '),
    password: () => ask('Telegram 2FA password: '),
    onError: (error) => { throw error; }
  });
  console.log('\nCopy this complete line into Render as TELEGRAM_SESSION:');
  console.log(client.session.save());
} finally {
  prompt.close();
  await client.disconnect();
}
