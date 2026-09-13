import type { BinaryData, Item } from '../types.js';

/**
 * Shaping a mail message into an item, and deciding whether a trigger wants it.
 *
 * Split from the poller for the same reason the Telegram one is: this half is
 * pure, so the filters and the item shape can be tested without an IMAP server
 * anywhere near the test run.
 */

export interface EmailTriggerConfig {
  credential?: string;
  folder?: string;
  /** Only messages the mailbox has not flagged \Seen. */
  unseenOnly?: boolean;
  /** Substring match on any sender address or display name. */
  fromContains?: string;
  /** Substring match on the subject. */
  subjectContains?: string;
  /** 'store' keeps attachment bytes, 'ignore' keeps only their metadata. */
  attachments?: string;
  /** 'seen' marks handled messages read; 'nothing' leaves the mailbox alone. */
  afterProcessing?: string;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

/** One message, already decoded. The poller builds these; nothing here does IO. */
export interface ParsedEmail {
  uid: number;
  messageId?: string;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  /** ISO 8601, when the message carried a parseable Date. */
  date?: string;
  text?: string;
  html?: string;
  flags: string[];
  attachments: EmailAttachment[];
}

export interface EmailAttachment {
  fileName?: string;
  mimeType: string;
  size: number;
  /** Absent when the trigger was told not to keep the bytes. */
  content?: Uint8Array;
}

export function matchesEmailTrigger(config: EmailTriggerConfig, email: ParsedEmail): boolean {
  const subject = trimmed(config.subjectContains);
  if (subject && !email.subject.toLowerCase().includes(subject.toLowerCase())) return false;

  const from = trimmed(config.fromContains);
  if (from) {
    const needle = from.toLowerCase();
    // Display name as well as address, because "only mail from Bob" is what
    // people mean, and plenty of senders are memorable by name only.
    const haystack = email.from.map((entry) => `${entry.name ?? ''} ${entry.address}`.toLowerCase());
    if (!haystack.some((entry) => entry.includes(needle))) return false;
  }

  // \Seen is checked here rather than in the IMAP search, so two triggers on
  // one mailbox with different answers both get what they asked for.
  if (config.unseenOnly && email.flags.includes('\\Seen')) return false;

  return true;
}

/** True when this trigger wants the bytes, not just the file names. */
export function wantsAttachmentBytes(config: EmailTriggerConfig): boolean {
  return (config.attachments ?? 'store') === 'store';
}

/** Whether any subscribed trigger needs the bytes, so the poller fetches once. */
export function anyWantsAttachmentBytes(configs: EmailTriggerConfig[]): boolean {
  return configs.some(wantsAttachmentBytes);
}

export function normaliseFolder(value: unknown): string {
  const folder = typeof value === 'string' ? value.trim() : '';
  return folder === '' ? 'INBOX' : folder;
}

/**
 * The item a matching message produces.
 *
 * `binaries` holds the already-stored attachments, in the same order as
 * `email.attachments`, and is empty when this trigger only wanted metadata.
 */
export function seedItemForEmail(email: ParsedEmail, folder: string, binaries: BinaryData[] = []): Item {
  const item: Item = {
    json: {
      uid: email.uid,
      messageId: email.messageId ?? null,
      folder,
      date: email.date ?? null,
      subject: email.subject,
      // The first sender on its own as well as the full list: expressions
      // almost always want one address, and `$json.from.address` beats
      // `$json.from[0].address` in the field where people write it.
      from: email.from[0] ?? null,
      fromAll: email.from,
      to: email.to,
      cc: email.cc,
      replyTo: email.replyTo[0] ?? null,
      text: email.text ?? null,
      html: email.html ?? null,
      flags: email.flags,
      attachments: email.attachments.map((attachment) => ({
        fileName: attachment.fileName ?? null,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
    },
  };

  if (binaries.length > 0) {
    // Keyed by position rather than by file name: names repeat within one
    // message, are missing on inline parts, and arrive holding anything at all.
    item.binary = Object.fromEntries(binaries.map((binary, index) => [`attachment_${index}`, binary]));
  }

  return item;
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
