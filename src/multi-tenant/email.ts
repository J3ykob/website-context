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
      subject: "Set your password - Whisp",
      replyTo: "jakub@whisp.so",
      text: `Welcome to Whisp.

Your AI chat widget is being set up. Set your dashboard password to manage your bot, view conversations and customize responses:

${setupUrl}

If you didn't sign up for Whisp, you can ignore this email.

Jakub
whisp.so`,
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

  const embedCode = `<script>\nwindow.__wctx={tenantId:"${tenantId}",apiHost:"${baseUrl}"};\nvar s=document.createElement("script");s.src="${baseUrl}/widget.js";s.async=true;document.head.appendChild(s);\n</script>`;

  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: "jakub@whisp.so",
      subject: `Your AI chatbot for ${domain} is live`,
      text: `Your AI chatbot for ${domain} is ready.

Try it here: ${demoUrl}

Ask it anything about the business - services, hours, pricing, contact info.

To add it to your site, paste this one line before the closing </body> tag:

${embedCode}

You can manage the bot, view conversations and customize replies here:
${dashboardUrl}

Reply to this email if you need a hand.

Jakub
whisp.so`,
    });
    console.log(`[email] Bot-ready email sent to ${email} (demo: ${demoUrl})`);
  } catch (error: any) {
    console.error(`[email] Failed to send bot-ready email to ${email}:`, error.message);
  }
}
