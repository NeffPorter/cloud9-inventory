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
  const body = JSON.