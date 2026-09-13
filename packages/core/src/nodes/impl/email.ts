import nodemailer, { type Transporter } from 'nodemailer';

import { NodeError, type Item, type NodeExecute, type NodeExecuteContext } from '../../types.js';

/**
 * Sending mail over SMTP, once per incoming item.
 *
 * One connection is opened for the whole node rather than one per item: a
 * hundred-item fan-out over a provider that rate-limits new connections is the
 * common shape, and reconnecting per message is what gets an account throttled.
 */

/** Per message. A slow relay should fail the item, not hang the execution. */
const SEND_TIMEOUT_MS = 60_000;

export const sendEmail: NodeExecute = async (ctx) => {
  const credential = await ctx.getCredential('credential');
  if (!credential) {
    throw new NodeError('ConfigurationError', 'Choose an SMTP credential.');
  }

  const transport = createTransport(credential);
  const out: Item[] = [];

  try {
    for (let index = 0; index < ctx.items.length; index++) {
      out.push(await sendOne(ctx, transport, credential, index));
    }
  } finally {
    transport.close();
  }

  return [out];
};

async function sendOne(
  ctx: NodeExecuteContext,
  transport: Transporter,
  credential: Record<string, string>,
  index: number,
): Promise<Item> {
  const from = text(ctx, 'from', index) ?? credential.from?.trim();
  if (!from || from === '') {
    throw new NodeError(
      'ConfigurationError',
      'No From address. Set one on this node, or a default on the SMTP credential.',
    );
  }

  const to = text(ctx, 'to', index);
  if (!to) throw new NodeError('ConfigurationError', 'To is required.');

  const html = text(ctx, 'html', index);
  const body = text(ctx, 'text', index);
  if (!html && !body) throw new NodeError('ConfigurationError', 'Give the message a text or an HTML body.');

  const attachments = await collectAttachments(ctx, index);

  try {
    const info = (await transport.sendMail({
      from,
      to,
      cc: text(ctx, 'cc', index),
      bcc: text(ctx, 'bcc', index),
      replyTo: text(ctx, 'replyTo', index),
      subject: text(ctx, 'subject', index) ?? '',
      ...(body ? { text: body } : {}),
      ...(html ? { html } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    })) as { messageId?: string; accepted?: unknown[]; rejected?: unknown[] };

    return {
      json: {
        messageId: info.messageId ?? null,
        accepted: info.accepted ?? [],
        rejected: info.rejected ?? [],
        attachments: attachments.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Authentication and a refused recipient are the two everyone hits, and
    // both are permanent: retrying them just delays the report.
    const code = (error as { code?: string }).code;
    const permanent = code === 'EAUTH' || code === 'EENVELOPE';
    throw new NodeError(permanent ? 'ConfigurationError' : 'SmtpError', message, { code: code ?? null });
  }
}

/**
 * Attachments come from the item's binary map, which is where the Email Trigger
 * and any future download node put files. `attach` names which keys to take:
 * blank for none, `*` for all of them, otherwise a comma-separated list.
 */
async function collectAttachments(
  ctx: NodeExecuteContext,
  index: number,
): Promise<Array<{ filename: string; content: Buffer; contentType: string }>> {
  const wanted = text(ctx, 'attach', index);
  if (!wanted) return [];

  const binary = ctx.items[index]?.binary ?? {};
  const keys =
    wanted === '*'
      ? Object.keys(binary)
      : wanted
          .split(',')
          .map((key) => key.trim())
          .filter((key) => key !== '');

  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];

  for (const key of keys) {
    const file = binary[key];
    if (!file) {
      // Named explicitly but absent: silently sending a mail without the
      // attachment someone asked for is worse than saying so.
      if (wanted !== '*') {
        throw new NodeError('ConfigurationError', `This item has no attachment called "${key}".`);
      }
      continue;
    }

    attachments.push({
      filename: file.fileName ?? key,
      content: Buffer.from(await ctx.readBinary(file)),
      contentType: file.mimeType,
    });
  }

  return attachments;
}

function createTransport(credential: Record<string, string>): Transporter {
  const host = (credential.host ?? '').trim();
  if (host === '') throw new NodeError('ConfigurationError', 'The SMTP credential has no host.');

  const security = (credential.security ?? 'tls').trim();
  // `secure` means TLS from the first byte. STARTTLS connects in the clear and
  // upgrades, which nodemailer does on its own when the server offers it.
  const secure = security === 'tls';
  const port = Number(credential.port) || (secure ? 465 : 587);

  return nodemailer.createTransport({
    host,
    port,
    secure,
    ...(credential.user
      ? { auth: { user: credential.user, pass: credential.password ?? '' } }
      : {}),
    requireTLS: security === 'starttls',
    tls: { rejectUnauthorized: (credential.allowSelfSigned ?? 'no') !== 'yes' },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
}

function text(ctx: NodeExecuteContext, name: string, index: number): string | undefined {
  const value = ctx.getParam(name, index);
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}
