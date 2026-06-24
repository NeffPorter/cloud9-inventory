/**
 * Email service via Gmail REST API (OAuth2).
 * Uses HTTPS port 443 — no SMTP ports needed.
 * Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GMAIL_USER in Railway.
 */

const https = require('https');

async function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  }).toString();

  const res = await httpsPost('oauth2.googleapis.com', '/token', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  }, body);

  const json = JSON.parse(res.body);
  if (!json.access_token) throw new Error(`Failed to get access token: ${res.body}`);
  return json.access_token;
}

async function sendEmail({ to, subject, html, text }) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const gmailUser = process.env.GMAIL_USER || 'noreplycloud9systems@gmail.com';

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn('[Email] Not configured — GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN missing.');
    return;
  }

  const recipient = Array.isArray(to) ? to.join(', ') : to;
  console.log(`[Email] Sending "${subject}" to ${recipient}`);

  const accessToken = await getAccessToken();

  // Build RFC 2822 message (encode subject for non-ASCII/emoji support)
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const message = [
    `From: Cloud 9 Vapor <${gmailUser}>`,
    `To: ${recipient}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html || text || ''
  ].join('\r\n');

  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = JSON.stringify({ raw: encoded });

  const res = await httpsPost('gmail.googleapis.com', '/gmail/v1/users/me/messages/send', {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  }, body);

  if (res.status >= 200 && res.status < 300) {
    console.log(`[Email] Sent OK to ${recipient}`);
  } else {
    throw new Error(`Gmail API error ${res.status}: ${res.body}`);
  }
}

async function sendNotificationEmail({ recipients, title, message, link }) {
  if (!recipients?.length) return;

  const appUrl = process.env.APP_BASE_URL || 'https://cloud9systems.up.railway.app';
  const linkHtml = link
    ? `<p style="margin-top:16px"><a href="${appUrl}${link}" style="background:#2563eb;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">View Details</a></p>`
    : '';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;">
      <div style="background:#1a1a2e;padding:16px 24px;border-radius:12px 12px 0 0;">
        <h1 style="color:white;margin:0;font-size:18px;">Cloud 9 Vapor</h1>
      </div>
      <div style="background:white;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
        <h2 style="margin:0 0 12px;font-size:17px;color:#1a1a1a;">${title}</h2>
        <p style="color:#555;line-height:1.6;margin:0;">${message}</p>
        ${linkHtml}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
        <p style="color:#aaa;font-size:12px;margin:0;">You received this because you have an active Cloud 9 Vapor account.</p>
      </div>
    </div>`;

  for (const email of recipients) {
    await sendEmail({
      to: email,
      subject: title,
      html,
      text: `${title}\n\n${message}${link ? '\n\n' + appUrl + link : ''}`
    });
  }
}

module.exports = { sendEmail, sendNotificationEmail };
