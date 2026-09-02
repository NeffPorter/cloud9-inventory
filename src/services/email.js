/**
 * Email service via SendGrid HTTP API.
 * Set SENDGRID_API_KEY in Railway env vars.
 * FROM address: admin@cloud9vapor.co
 */

const sgMail = require('@sendgrid/mail');

let _configured = false;

function configure() {
  if (_configured) return true;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return false;
  sgMail.setApiKey(key);
  _configured = true;
  return true;
}

const FROM = 'Cloud 9 Vapor <admin@cloud9vapor.co>';

async function sendEmail({ to, subject, html, text }) {
  if (!configure()) {
    console.warn('[Email] Not configured — SENDGRID_API_KEY missing.');
    return;
  }

  const recipient = Array.isArray(to) ? to : [to];
  console.log(`[Email] Sending "${subject}" to ${recipient.join(', ')}`);

  try {
    await sgMail.send({
      from: FROM,
      to: recipient,
      subject,
      html: html || text || '',
      text: text || ''
    });
    console.log(`[Email] Sent OK to ${recipient.join(', ')}`);
  } catch (err) {
    const detail = err.response?.body?.errors?.[0]?.message || err.message;
    console.error(`[Email] Failed to send to ${recipient.join(', ')}:`, detail);
    throw err;
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
