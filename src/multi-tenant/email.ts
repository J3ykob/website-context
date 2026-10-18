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

/**
 * A customer's confirmed order / inquiry from an "in chat" flow, to the owner.
 */
export async function sendInquiryEmail(
  email: string,
  brand: string,
  inquiry: { flowName: string; fields: { label: string; value: string }[]; transcript: string[]; at: string; via?: { brand: string } },
): Promise<boolean> {
  const lines = inquiry.fields.map((f) => `${f.label}: ${f.value}`).join("\n");
  const via = inquiry.via ? ` przez bota ${inquiry.via.brand}` : "";
  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: "jakub@whisp.so",
      subject: `Nowe zapytanie z czatu${via}: ${inquiry.flowName} (${brand})`,
      text: `Klient wysłał${inquiry.via ? ` przez asystenta firmy ${inquiry.via.brand} (polecenie w ekosystemie)` : " przez asystenta na stronie"} zapytanie „${inquiry.flowName}” i potwierdził dane.

${lines}

Rozmowa:
${inquiry.transcript.join("\n")}

Wysłano ${inquiry.at} przez Whisp.`,
    });
    if (error) { console.error(`[email] inquiry email to ${email} failed:`, error.message); return false; }
    console.log(`[email] Inquiry email sent to ${email} (${inquiry.flowName})`);
    return true;
  } catch (e: any) {
    console.error(`[email] inquiry email to ${email} failed:`, e.message);
    return false;
  }
}

// The owner's review of work the assistant prepared for a customer (src/projects/review.ts).
// New template: until the user approves it (REVIEW_EMAIL_APPROVED=1), it goes only to the Whisp owner's
// own address - never to a business.
export async function sendReviewEmail(
  email: string,
  brand: string,
  r: { request: string; draft: string; files: string[]; link: string; questions?: string[] },
): Promise<boolean> {
  if (process.env.REVIEW_EMAIL_APPROVED !== "1" && email.toLowerCase() !== "kubalol7982@gmail.com") {
    console.log(`[email] review email to ${email} not sent - template awaiting approval`);
    return false;
  }
  const files = r.files.length ? `\nPliki dla klienta: ${r.files.map((f) => f.split("/").pop()).join(", ")}\n` : "";
  // The questions block is an addition to the approved template: included once approved.
  const questions = r.questions?.length && process.env.REVIEW_EMAIL_QUESTIONS_APPROVED === "1"
    ? `\nAsystent ma pytania do Ciebie (klient ich nie widzi):\n${r.questions.map((q, k) => `${k + 1}. ${q}`).join("\n")}\nOdpowiedz na nie pod linkiem poniżej - asystent poprawi odpowiedź.\n` : "";
  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: "jakub@whisp.so",
      subject: `Do akceptacji: odpowiedź dla klienta (${brand})`,
      text: `Asystent na stronie przygotował odpowiedź na prośbę klienta. Klient dostanie ją dopiero po Twojej akceptacji.

Prośba klienta:
${r.request}

Proponowana odpowiedź:
${r.draft || "(asystent nie zdołał przygotować odpowiedzi - napisz ją sam)"}
${files}${questions}
Zobacz szczegóły, popraw albo zaakceptuj (bez logowania):
${r.link}

Możesz: wysłać bez zmian, poprawić tekst, poprosić asystenta o zmiany albo odpowiedzieć klientowi po swojemu.

Whisp`,
    });
    if (error) { console.error(`[email] review email to ${email} failed:`, error.message); return false; }
    console.log(`[email] Review email sent to ${email}`);
    return true;
  } catch (e: any) {
    console.error(`[email] review email to ${email} failed:`, e.message);
    return false;
  }
}

// A business that has not joined the network (src/projects/invite.ts, which also holds the text).
// New template: until the user approves it (NETWORK_INVITE_EMAIL_APPROVED=1) it goes only to the Whisp
// owner's own address - never to a business.
export async function sendNetworkInviteEmail(email: string, mail: { subject: string; text: string }): Promise<boolean> {
  if (process.env.NETWORK_INVITE_EMAIL_APPROVED !== "1" && email.toLowerCase() !== "kubalol7982@gmail.com") {
    console.log(`[email] network invite to ${email} not sent - template awaiting approval`);
    return false;
  }
  try {
    const { error } = await resend.emails.send({ from: FROM, to: email, replyTo: "jakub@whisp.so", subject: mail.subject, text: mail.text });
    if (error) { console.error(`[email] network invite to ${email} failed:`, error.message); return false; }
    console.log(`[email] Network invite sent to ${email}`);
    return true;
  } catch (e: any) {
    console.error(`[email] network invite to ${email} failed:`, e.message);
    return false;
  }
}

// The result of a customer's request, sent when the customer asked for it in the chat (with consent).
// New template: until the user approves it (CUSTOMER_RESULT_EMAIL_APPROVED=1), it goes only to the Whisp
// owner's own address.
const RESULT_TEXT: Record<string, { subject: string; intro: string; files: string; reply: string }> = {
  pl: { subject: "Wynik Twojego zapytania - {brand}", intro: "Oto odpowiedź na Twoje zapytanie w czacie na stronie {brand}:", files: "Pliki:", reply: "Możesz odpowiedzieć na tę wiadomość - trafi bezpośrednio do firmy." },
  en: { subject: "The result of your request - {brand}", intro: "Here is the answer to your request in the chat on the {brand} website:", files: "Attached:", reply: "You can reply to this email - it goes directly to the business." },
  uk: { subject: "Результат вашого запиту - {brand}", intro: "Ось відповідь на ваш запит у чаті на сайті {brand}:", files: "У вкладенні:", reply: "Ви можете відповісти на цей лист - він надійде безпосередньо до компанії." },
  fr: { subject: "Le résultat de votre demande - {brand}", intro: "Voici la réponse à votre demande dans le chat du site {brand} :", files: "En pièce jointe :", reply: "Vous pouvez répondre à cet e-mail - il est envoyé directement à l'entreprise." },
  de: { subject: "Das Ergebnis Ihrer Anfrage - {brand}", intro: "Hier ist die Antwort auf Ihre Anfrage im Chat auf der Website von {brand}:", files: "Im Anhang:", reply: "Sie können auf diese E-Mail antworten - sie geht direkt an das Unternehmen." },
};

export async function sendResultEmail(
  email: string,
  r: { brand: string; replyTo: string; lang: string; message: string; files: { name: string; content: Buffer }[]; site: string },
): Promise<boolean> {
  if (process.env.CUSTOMER_RESULT_EMAIL_APPROVED !== "1" && email.toLowerCase() !== "kubalol7982@gmail.com") {
    console.log(`[email] result email to ${email} not sent - template awaiting approval`);
    return false;
  }
  const t = RESULT_TEXT[r.lang] || RESULT_TEXT.en;
  const fill = (x: string) => x.split("{brand}").join(r.brand);
  // The files themselves, attached (the text names them).
  const files = r.files.length ? `\n${t.files} ${r.files.map((f) => f.name).join(", ")}\n` : "";
  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: r.replyTo || "jakub@whisp.so",
      subject: fill(t.subject),
      attachments: r.files.map((f) => ({ filename: f.name, content: f.content })),
      text: `${fill(t.intro)}

${r.message}
${files}
${t.reply}
${r.site ? `\n${r.brand} - ${r.site}` : `\n${r.brand}`}`,
    });
    if (error) { console.error(`[email] result email to ${email} failed:`, error.message); return false; }
    console.log(`[email] Result email sent to ${email}`);
    return true;
  } catch (e: any) {
    console.error(`[email] result email to ${email} failed:`, e.message);
    return false;
  }
}
