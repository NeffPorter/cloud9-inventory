/**
 * Email service via Brevo (formerly Sendinblue) HTTP API.
 * Set BREVO_API_KEY and GMAIL_USER in Railway environment variables.
 */

const https = require('https');

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  const sender = process.env.GMAIL_USER || 'noreplycloud9systems@gmail.com';

  if (!apiKey) {
    console.warn('[Email] Not configured — BREVO_API_KEY missing, skipping send.');
    return;
  }

  const recipient = Array.isArray(to) ? to : [to];
  console.log(`[Email] Sending "${subject}" to ${recipient.join(', ')}`);

  const body = JSON.stringify({
    sender: { name: 'Cloud 9 Vapor', email: sender },
    to: recipient.map(email => ({ email })),
    subject,
    htmlContent: html,
    textContent: text
  });

  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Email] Sent OK to ${recipient.join(', ')}`);
          resolve();
        } else {
          reject(new Error(`Brevo API error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Brevo request timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Send a notification email to a list of recipient email addresses.
 */
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
