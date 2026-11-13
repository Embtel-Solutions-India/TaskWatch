import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { emailHtml } from './emailTemplates.js';

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

/**
 * Email over SMTP (Brevo relay), sender name "TaskWatch". Without `html`, the body goes in the plain branded shell.
 * `automated`: sent by the alert queue, not by a person; simulated outside production (config.smtp.automated).
 */
export async function sendEmail(msg: OutgoingMessage, html?: string, automated = false): Promise<SendResult> {
  if (!(automated ? config.smtp.automated : config.smtp.enabled)) return { simulated: true, providerId: null };
  // Nodemailer resolves hosts with dns.resolve (queries the DNS server directly), which times out on networks where only
  // the OS resolver works. Resolve with dns.lookup (OS resolver) instead; TLS still verifies the real hostname.
  // ponytail: IP fixed for the process lifetime; re-resolve per send if the relay's address ever rotates mid-run.
  transport ??= nodemailer.createTransport({
    host: (await dns.lookup(config.smtp.host)).address,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    tls: { servername: config.smtp.host },
  });
  const text = msg.link ? `${msg.body}\n\n${msg.link}` : msg.body;
  const body = html ?? emailHtml(msg.body, msg.link, 'Open TaskWatch', msg.subject ?? '');
  // Illustrations travel inside the email (cid:), so they show without the app being publicly reachable.
  const arts = [...new Set([...body.matchAll(/cid:tw-art-(\w+)/g)].map((m) => m[1]!))];
  const info = await transport.sendMail({
    from: { name: config.smtp.fromName, address: config.smtp.fromAddress },
    to: msg.address,
    subject: msg.subject ?? 'TaskWatch',
    text,
    html: body,
    attachments: arts.map((a) => ({ filename: `${a}.png`, path: fileURLToPath(new URL(`./art/${a}.png`, import.meta.url)), cid: `tw-art-${a}` })),
  });
  return { simulated: false, providerId: info.messageId ?? null };
}
