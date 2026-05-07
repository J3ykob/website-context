/**
 * Email Service — sends transactional emails via Resend.
 */

import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = "onboarding@resend.dev";

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
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#fafaf8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid #e7e5e4;padding:48px 40px;">
        <tr><td>
          <div style="width:36px;height:36px;background:#1c1917;border-radius:9px;margin-bottom:28px;"></div>
          <h1 style="font-family:Georgia,serif;font-size:26px;font-weight:400;color:#1c1917;margin:0 0 12px;">Welcome to Whisp</h1>
          <p style="font-size:15px;color:#57534e;line-height:1.6;margin:0 0 28px;">
            Your AI chat widget is being set up. Set your dashboard password to manage your bot, view conversations, and customize responses.
          </p>
          <a href="${setupUrl}" style="display:inline-block;background:#1c1917;color:#ffffff;font-size:14px;font-weight:600;padding:14px 28px;border-radius:10px;text-decoration:none;">Set your password</a>
          <p style="font-size:12px;color:#a8a29e;margin-top:28px;line-height:1.5;">
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
 */
export async function sendBotReadyEmail(
  email: string,
  tenantId: string,
  domain: string,
  baseUrl: string
): Promise<void> {
  const dashboardUrl = `${baseUrl}/auth/login`;
  const embedCode = `&lt;script&gt;
(function() {
  var s = document.createElement('script');
  s.src = '${baseUrl}/widget.js';
  s.setAttribute('data-tenant-id', '${tenantId}');
  s.setAttribute('data-api-url', '${baseUrl}');
  document.head.appendChild(s);
})();
&lt;/script&gt;`;

  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: `Your bot is ready! — ${domain}`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#fafaf8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid #e7e5e4;padding:48px 40px;">
        <tr><td>
          <div style="width:36px;height:36px;background:#16a34a;border-radius:9px;margin-bottom:28px;"></div>
          <h1 style="font-family:Georgia,serif;font-size:26px;font-weight:400;color:#1c1917;margin:0 0 12px;">Your bot is ready!</h1>
          <p style="font-size:15px;color:#57534e;line-height:1.6;margin:0 0 8px;">
            We've finished scraping <strong>${domain}</strong> and your AI chat widget is live. Visitors can now chat with your website.
          </p>
          <p style="font-size:15px;color:#57534e;line-height:1.6;margin:0 0 28px;">
            Add this snippet to your site to embed the widget:
          </p>
          <div style="background:#f6f5f1;border:1px solid #e7e5e4;border-radius:10px;padding:16px;margin-bottom:28px;">
            <code style="font-size:12px;color:#1c1917;white-space:pre-wrap;word-break:break-all;">${embedCode}</code>
          </div>
          <a href="${dashboardUrl}" style="display:inline-block;background:#1c1917;color:#ffffff;font-size:14px;font-weight:600;padding:14px 28px;border-radius:10px;text-decoration:none;">Open Dashboard</a>
          <p style="font-size:12px;color:#a8a29e;margin-top:28px;line-height:1.5;">
            You can manage your bot, view conversations, and teach it new answers from the dashboard.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
    console.log(`[email] Bot-ready email sent to ${email}`);
  } catch (error: any) {
    console.error(`[email] Failed to send bot-ready email to ${email}:`, error.message);
  }
}
