/**
 * Email Service — sends transactional emails via Resend.
 */

import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM || "Jakub <jakub@whisp.so>";

/**
 * Send welcome email with password setup link.
 */
export async function sendWelcomeEmail(
  email: string,
  tenantId: string,
  setupToken: string,
  baseUrl: string
): Promise<void> {
  const setupUrl = `${baseUrl}/auth/setup?token=${encodeURIComponent(setupToken)}&tenant=${encodeURIComponent(tenantId)}`;

  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: "Set your password — Whisp",
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#111827;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:48px 40px;">
        <tr><td>
          <div style="width:32px;height:32px;background:#3b82f6;border-radius:8px;margin-bottom:28px;"></div>
          <h1 style="font-family:Georgia,serif;font-size:26px;font-weight:400;color:#f1f5f9;margin:0 0 12px;">Welcome to Whisp</h1>
          <p style="font-size:15px;color:#94a3b8;line-height:1.6;margin:0 0 28px;">
            Your AI chat widget is being set up. Set your dashboard password to manage your bot, view conversations, and customize responses.
          </p>
          <a href="${setupUrl}" style="display:inline-block;background:#3b82f6;color:#ffffff;font-size:14px;font-weight:600;padding:14px 28px;border-radius:10px;text-decoration:none;">Set your password</a>
          <p style="font-size:12px;color:#475569;margin-top:28px;line-height:1.5;">
            If you didn't sign up for Whisp, you can ignore this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
    console.log(`[email] Welcome email sent to ${email}`);
  } catch (error: any) {
    console.error(`[email] Failed to send welcome email to ${email}:`, error.message);
  }
}

/**
 * Send "bot ready" email when scraping completes.
 * Includes demo link and embed code — only sent when demo is verified working.
 */
export async function sendBotReadyEmail(
  email: string,
  tenantId: string,
  domain: string,
  baseUrl: string
): Promise<void> {
  const demoUrl = `${baseUrl}/demo/${tenantId}`;
  const siteUrl = `${baseUrl}/site/${tenantId}`;
  const dashboardUrl = `${baseUrl}/auth/login`;

  const embedCode = `&lt;script&gt;\nwindow.__wctx={tenantId:"${tenantId}",apiHost:"${baseUrl}"};\nvar s=document.createElement("script");s.src="${baseUrl}/widget.js";s.async=true;document.head.appendChild(s);\n&lt;/script&gt;`;

  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: "jakub@whisp.so",
      subject: `Your AI chatbot for ${domain} is live`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#111827;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:48px 40px;">
        <tr><td>
          <div style="width:32px;height:32px;background:#10b981;border-radius:8px;margin-bottom:28px;"></div>
          <h1 style="font-family:Georgia,serif;font-size:26px;font-weight:400;color:#f1f5f9;margin:0 0 12px;">Your chatbot is live!</h1>
          <p style="font-size:15px;color:#94a3b8;line-height:1.6;margin:0 0 24px;">
            We've read <strong style="color:#f1f5f9;">${domain}</strong> and your AI chatbot is ready. Try it:
          </p>
          <a href="${demoUrl}" style="display:inline-block;background:#3b82f6;color:#ffffff;font-size:14px;font-weight:600;padding:14px 28px;border-radius:10px;text-decoration:none;margin-bottom:16px;">Try your demo</a>
          <p style="font-size:13px;color:#64748b;line-height:1.6;margin:16px 0 28px;">
            Ask it anything about your business - services, hours, pricing, contact info.
          </p>
          <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;margin-top:8px;">
            <p style="font-size:13px;color:#94a3b8;font-weight:600;margin:0 0 12px;">Add to your website (one line of code):</p>
            <div style="background:#0a0e1a;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;margin-bottom:24px;">
              <code style="font-size:11px;color:#94a3b8;white-space:pre-wrap;word-break:break-all;">${embedCode}</code>
            </div>
          </div>
          <a href="${dashboardUrl}" style="display:inline-block;background:rgba(255,255,255,0.06);color:#94a3b8;font-size:13px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none;border:1px solid rgba(255,255,255,0.08);">Open Dashboard</a>
          <p style="font-size:11px;color:#334155;margin-top:28px;line-height:1.5;">
            Whisp - whisp.so | Reply to this email if you need help.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
    console.log(`[email] Bot-ready email sent to ${email} (demo: ${demoUrl})`);
  } catch (error: any) {
    console.error(`[email] Failed to send bot-ready email to ${email}:`, error.message);
  }
}
