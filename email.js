const BREVO_TRANSACTIONAL_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';

export async function sendPasswordResetEmail(email, code) {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const senderEmail = process.env.EMAIL_FROM_ADDRESS?.trim();
  if (!apiKey || !senderEmail) {
    console.warn(`Password reset email skipped (BREVO_API_KEY/EMAIL_FROM_ADDRESS missing). Code for ${email}: ${code}`);
    return;
  }
  const response = await fetch(BREVO_TRANSACTIONAL_EMAIL_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: process.env.EMAIL_FROM_NAME?.trim() || 'RH Stream', email: senderEmail },
      to: [{ email }],
      subject: `Your RH Stream password reset code is ${code}`,
      htmlContent: `<!doctype html><html><body style="margin:0;background:#0b0b0b;color:#f4f1ed;font-family:Arial,sans-serif;">
        <div style="max-width:480px;margin:0 auto;padding:32px 20px;">
          <p style="margin:0 0 16px;">Hello,</p>
          <p style="margin:0 0 20px;">Someone requested a password reset for this RH Stream account. Enter this code to set a new password:</p>
          <p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:4px;">${code}</p>
          <p style="margin:0;color:#999;font-size:12px;">This code expires in 15 minutes. If you didn't request it, ignore this email.</p>
        </div>
      </body></html>`,
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Email send failed (${response.status})`);
  }
}
