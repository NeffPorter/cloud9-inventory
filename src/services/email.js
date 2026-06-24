/**
 * Email service via Gmail SMTP (nodemailer).
 * Set GMAIL_USER and GMAIL_PASS (Google App Password) in Railway environment variables.
 */

const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

function getTransporter() {
  if (!GMAIL_USER || !GMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });
}

async function sendEmail({ to, subject, html, text }) {
  const transporter = getTransporter();
  if (!transporter) {
    // Not configured — silently skip (don't crash the app)
    return;
  }

  try {
    await transporter.sendMail({
      from: `Cloud 9 Vapor <${GMAIL_USER}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
      text
    });
  } catch (err) {
    console.error('[Email] sendEmail error:', err.message);
  }
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
