import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

export interface OutgoingMessage {
  address: string;
  subject: string | null;
  body: string;
  template: string | null;
  templateParams: string[] | null;
  link: string | null;
  taskId: number | null;
}

export interface SendResult {
  simulated: boolean;
  providerId: string | null;
}

// WhatsApp body parameters may not contain newlines, tabs or long runs of spaces.
function waParam(text: string): string {
  return text.replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 900);
}

/** WhatsApp Business Cloud API, using pre-approved templates (see docs/whatsapp-templates.md). */
export async function sendWhatsApp(msg: OutgoingMessage): Promise<SendResult> {
  if (!config.whatsapp.enabled) return { simulated: true, providerId: null };
  if (!msg.template) throw new Error('No WhatsApp template for this event');

  const components: unknown[] = [
    { type: 'body', parameters: (msg.templateParams ?? []).map((t) => ({ type: 'text', text: waParam(t) })) },
  ];
  if (msg.taskId != null) {
    // Every template has an "Open task" URL button ending in {{1}} = task id.
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(msg.taskId) }] });
  }

  const res = await fetch(
    `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: msg.address.replace(/[^\d]/g, ''),
        type: 'template',
        template: { name: msg.template, language: { code: config.whatsapp.lang }, components },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data?.error?.message ?? `WhatsApp API returned ${res.status}`);
  return { simulated: false, providerId: data?.messages?.[0]?.id ?? null };
}

let transport: Transporter | null = null;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function emailHtml(body: string, link: string | null, linkLabel = 'Open in TaskWatch'): string {
  const paragraphs = escapeHtml(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = link
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(link)}" style="background:#1f4f8f;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(linkLabel)}</a></p>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1d2433;max-width:560px">${paragraphs}${button}<p style="margin:24px 0 0;color:#6b7280;font-size:12px">Sent by TaskWatch</p></div>`;
}

/** Email through the Google Workspace domain, sender name "TaskWatch". */
export async function sendEmail(msg: OutgoingMessage, html?: string): Promise<SendResult> {
  if (!config.smtp.enabled) return { simulated: true, providerId: null };
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  const text = msg.link ? `${msg.body}\n\n${msg.link}` : msg.body;
  const info = await transport.sendMail({
    from: { name: config.smtp.fromName, address: config.smtp.fromAddress },
    to: msg.address,
    subject: msg.subject ?? 'TaskWatch',
    text,
    html: html ?? emailHtml(msg.body, msg.link),
  });
  return { simulated: false, providerId: info.messageId ?? null };
}
