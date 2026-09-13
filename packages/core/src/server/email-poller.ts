import { randomUUID } from 'node:crypto';

import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';

import type { BinaryData } from '../types.js';
import { claimBinaries, putBinary } from './binary.js';
import { loadCredentialData } from './credentials.js';
import { prisma } from './db.js';
import {
  anyWantsAttachmentBytes,
  matchesEmailTrigger,
  normaliseFolder,
  seedItemForEmail,
  wantsAttachmentBytes,
  type EmailAddress,
  type EmailTriggerConfig,
  type ParsedEmail,
} from './email-messages.js';
import { createExecution } from './executions.js';

/**
 * Polling IMAP, one poller per mailbox rather than one per trigger.
 *
 * The arrangement is the Telegram poller's, for the same reason: the cursor
 * belongs to the mailbox, so two triggers reading one folder independently
 * would each move a cursor the other also owns and steal each other's mail.
 * Here the mailbox is polled once and every trigger whose filters match gets
 * the message, so pointing three workflows at one inbox is supported rather
 * than being a conflict to report.
 *
 * Polling rather than IDLE: IDLE means holding an open connection per folder
 * for as long as the workflow is active, which does not fit a lease that has to
 * be handed between workers. A minute of latency is the price.
 */

/** How long a worker holds a mailbox while polling it. Longer than one poll. */
const LEASE_MS = 120_000;

/** Wait between passes over the mailboxes. */
const POLL_INTERVAL_MS = Number(process.env.M8X_EMAIL_POLL_SECONDS ?? 60) * 1000;

/** Idle wait when no workflow is listening to any mailbox. */
const IDLE_MS = 30_000;

/** Backoff after a failed poll, doubling to this ceiling. */
const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/** Messages handled in one pass, so a busy mailbox cannot monopolise a worker. */
const MAX_PER_POLL = 25;

/** Give up on a mailbox that will not answer. */
const CONNECT_TIMEOUT_MS = 30_000;

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface SubscribedTrigger {
  workflowId: string;
  nodeId: string;
  config: EmailTriggerConfig;
}

/** A mailbox is a credential and a folder: one cursor, many triggers. */
interface MailboxKey {
  credentialId: string;
  folder: string;
}

let controller: AbortController | null = null;
let loop: Promise<void> | null = null;

const backoff = new Map<string, { until: number; ms: number }>();

export function startEmailPoller(log: (message: string) => void = console.info): void {
  if (controller) return;
  controller = new AbortController();
  const signal = controller.signal;
  loop = pollForever(signal, log).catch((error) => {
    console.error('[email] poller stopped unexpectedly', error);
  });
}

export async function stopEmailPoller(): Promise<void> {
  if (!controller) return;
  controller.abort();
  controller = null;
  await loop?.catch(() => {});
  loop = null;
  backoff.clear();
}

async function pollForever(signal: AbortSignal, log: (message: string) => void): Promise<void> {
  while (!signal.aborted) {
    let mailboxes: Map<string, SubscribedTrigger[]>;

    try {
      mailboxes = await subscribedMailboxes();
    } catch (error) {
      console.error('[email] could not load triggers', error);
      await sleep(IDLE_MS, signal);
      continue;
    }

    if (mailboxes.size === 0) {
      await sleep(IDLE_MS, signal);
      continue;
    }

    // In parallel across mailboxes, since each spends its time waiting on a
    // server. Within one mailbox everything stays sequential.
    await Promise.all([...mailboxes].map(([key, triggers]) => pollMailbox(parseKey(key), triggers, signal, log)));

    // Unlike Telegram there is no long poll to pace this, so the interval is
    // the pacing.
    if (!signal.aborted) await sleep(POLL_INTERVAL_MS, signal);
  }
}

/** Enabled email triggers on active workflows, grouped by mailbox. */
async function subscribedMailboxes(): Promise<Map<string, SubscribedTrigger[]>> {
  const rows = await prisma.trigger.findMany({
    where: { kind: 'email', enabled: true, workflow: { active: true } },
    select: { workflowId: true, nodeId: true, config: true },
  });

  const mailboxes = new Map<string, SubscribedTrigger[]>();

  for (const row of rows) {
    const config = (row.config ?? {}) as EmailTriggerConfig;
    const credentialId = typeof config.credential === 'string' ? config.credential.trim() : '';
    if (credentialId === '') continue;

    const key = keyOf({ credentialId, folder: normaliseFolder(config.folder) });
    const trigger: SubscribedTrigger = { workflowId: row.workflowId, nodeId: row.nodeId, config };

    const existing = mailboxes.get(key);
    if (existing) existing.push(trigger);
    else mailboxes.set(key, [trigger]);
  }

  return mailboxes;
}

async function pollMailbox(
  mailbox: MailboxKey,
  triggers: SubscribedTrigger[],
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<void> {
  const key = keyOf(mailbox);
  const waiting = backoff.get(key);
  if (waiting && waiting.until > Date.now()) return;

  const cursor = await takeLease(mailbox);
  // Another worker holds this mailbox, which is the point of the lease.
  if (cursor === null) return;

  let client: ImapFlow | null = null;

  try {
    client = await connect(mailbox.credentialId, signal);
    const lock = await client.getMailboxLock(mailbox.folder);

    try {
      const status = client.mailbox;
      if (!status || typeof status === 'boolean') throw new Error(`folder ${mailbox.folder} could not be opened`);

      const uidValidity = BigInt(status.uidValidity);
      const uidNext = BigInt(status.uidNext ?? 1);

      // First sight of this mailbox, or a server that renumbered it. Either way
      // the stored UIDs mean nothing, and replaying an entire inbox because a
      // workflow was switched on is never what anyone wants: start at the end.
      if (cursor.uidValidity === null || cursor.uidValidity !== uidValidity) {
        const from = uidNext > 0n ? uidNext - 1n : 0n;
        await releaseLease(mailbox, { lastUid: from, uidValidity }, null);
        log(
          cursor.uidValidity === null
            ? `[email] watching ${mailbox.folder} from UID ${from}, only new mail from here`
            : `[email] ${mailbox.folder} was renumbered by the server, resyncing from UID ${from}`,
        );
        return;
      }

      const handled = await drain(client, mailbox, cursor.lastUid, triggers, signal, log);

      // Committed only once every execution exists. A crash in between
      // redelivers the message, which beats losing it.
      await releaseLease(mailbox, handled > cursor.lastUid ? { lastUid: handled, uidValidity } : null, null);
      backoff.delete(key);
    } finally {
      lock.release();
    }
  } catch (error) {
    if (signal.aborted) {
      await releaseLease(mailbox, null, null).catch(() => {});
      return;
    }

    const reason = error instanceof Error ? error.message : String(error);
    const previous = backoff.get(key)?.ms ?? 0;
    const ms = Math.min(previous === 0 ? MIN_BACKOFF_MS : previous * 2, MAX_BACKOFF_MS);
    backoff.set(key, { until: Date.now() + ms, ms });

    await releaseLease(mailbox, null, reason).catch(() => {});
    log(`[email] ${mailbox.folder} failed, retrying in ${Math.round(ms / 1000)}s: ${reason}`);
  } finally {
    // logout() is the polite close; a socket that is already broken should not
    // turn into a second failure on the way out.
    await client?.logout().catch(() => {});
  }
}

/**
 * Handle everything above `lastUid`, returning the highest UID turned into
 * executions. Returns `lastUid` unchanged when there was nothing to do.
 */
async function drain(
  client: ImapFlow,
  mailbox: MailboxKey,
  lastUid: bigint,
  triggers: SubscribedTrigger[],
  signal: AbortSignal,
  log: (message: string) => void,
): Promise<bigint> {
  const wantBytes = anyWantsAttachmentBytes(triggers.map((trigger) => trigger.config));

  const messages: FetchMessageObject[] = [];
  for await (const message of client.fetch(
    { uid: `${lastUid + 1n}:*` },
    { uid: true, flags: true, source: true },
    { uid: true },
  )) {
    // `N:*` is defined to return the last message even when its UID is below N,
    // so an idle mailbox hands back the same message every pass. Dropping it
    // here is what stops that becoming an execution a minute, forever.
    if (BigInt(message.uid) <= lastUid) continue;
    messages.push(message);
    if (messages.length >= MAX_PER_POLL) break;
  }

  if (messages.length === 0) return lastUid;

  let highest = lastUid;
  const markSeen: number[] = [];

  for (const message of messages) {
    if (signal.aborted) break;

    const email = await parseMessage(message, wantBytes);
    let delivered = false;

    for (const trigger of triggers) {
      if (!matchesEmailTrigger(trigger.config, email)) continue;

      try {
        await deliver(email, mailbox, trigger);
        delivered = true;
        if ((trigger.config.afterProcessing ?? 'nothing') === 'seen') markSeen.push(email.uid);
      } catch (error) {
        // One broken workflow must not stop the message reaching the others,
        // and must not hold the cursor: a workflow that cannot be queued now
        // will not be queueable on a redelivery either.
        console.error(`[email] could not queue workflow ${trigger.workflowId}`, error);
      }
    }

    if (delivered) log(`[email] ${mailbox.folder} UID ${email.uid} delivered to ${triggers.length} trigger(s)`);

    // Advanced even when nothing matched: the message has been considered, and
    // leaving the cursor behind would re-examine it on every pass forever.
    highest = BigInt(email.uid);
  }

  if (markSeen.length > 0) {
    await client
      .messageFlagsAdd({ uid: markSeen.join(',') }, ['\\Seen'], { uid: true })
      .catch((error: unknown) => console.error('[email] could not mark messages seen', error));
  }

  return highest;
}

/** One execution for one trigger, with this trigger's own copy of the bytes. */
async function deliver(email: ParsedEmail, mailbox: MailboxKey, trigger: SubscribedTrigger): Promise<void> {
  const binaries: BinaryData[] = [];

  if (wantsAttachmentBytes(trigger.config)) {
    for (const attachment of email.attachments) {
      if (!attachment.content) continue;
      binaries.push(
        await putBinary({
          bytes: attachment.content,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
        }),
      );
    }
  }

  const item = seedItemForEmail(email, mailbox.folder, binaries);

  // If this throws, the objects stay unclaimed and the orphan prune collects
  // them; that is why they are written before the run rather than after.
  const { executionId } = await createExecution({
    workflowId: trigger.workflowId,
    trigger: 'email',
    input: [item],
    // Named explicitly, so a workflow with two triggers starts at this one.
    startNodeId: trigger.nodeId,
  });

  // Now that the run exists, the bytes belong to it and go when it does.
  await claimBinaries(
    binaries.flatMap((binary) => (binary.ref ? [binary.ref] : [])),
    executionId,
  );
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

/** Connection options from a stored credential. Exported for tests. */
export function connectionOptions(credential: Record<string, string>): {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  tls: { rejectUnauthorized: boolean };
} {
  const host = (credential.host ?? '').trim();
  if (host === '') throw new Error('the IMAP credential has no host');

  const security = (credential.security ?? 'tls').trim();
  // Only an implicit-TLS connection is `secure`; STARTTLS begins in the clear
  // and upgrades, which is what imapflow does by default on a plain port.
  const secure = security === 'tls';
  const port = Number(credential.port) || (secure ? 993 : 143);

  return {
    host,
    port,
    secure,
    auth: { user: credential.user ?? '', pass: credential.password ?? '' },
    tls: { rejectUnauthorized: (credential.allowSelfSigned ?? 'no') !== 'yes' },
  };
}

async function connect(credentialId: string, signal: AbortSignal): Promise<ImapFlow> {
  const credential = await loadCredentialData(credentialId);
  if (!credential) throw new Error('the IMAP credential is missing');

  const client = new ImapFlow({
    ...connectionOptions(credential),
    // Its own logging is extremely chatty and would drown the worker log.
    logger: false,
    emitLogs: false,
  });

  // A dead host otherwise hangs the mailbox until the lease expires.
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]);
  const abort = new Promise<never>((_, reject) => {
    timeout.addEventListener('abort', () => reject(new Error('the server did not answer in time')), { once: true });
  });

  await Promise.race([client.connect(), abort]);
  return client;
}

async function parseMessage(message: FetchMessageObject, wantBytes: boolean): Promise<ParsedEmail> {
  if (!message.source) throw new Error(`message UID ${message.uid} came back without a body`);
  const parsed: ParsedMail = await simpleParser(message.source);

  return {
    uid: message.uid,
    messageId: parsed.messageId,
    subject: parsed.subject ?? '',
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    replyTo: addresses(parsed.replyTo),
    date: parsed.date?.toISOString(),
    text: parsed.text,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    flags: [...(message.flags ?? [])],
    attachments: parsed.attachments.map((attachment) => ({
      fileName: attachment.filename,
      mimeType: attachment.contentType ?? 'application/octet-stream',
      size: attachment.size,
      // Metadata is always present; the bytes only when a trigger asked, so a
      // workflow that just reads subjects never pulls a 20 MB file off the wire
      // and into the database.
      content: wantBytes ? attachment.content : undefined,
    })),
  };
}

/** mailparser hands back either one address object or a list, or nothing. */
function addresses(value: unknown): EmailAddress[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];

  return list.flatMap((entry) => {
    const parsed = entry as { value?: Array<{ address?: string; name?: string }> };
    return (parsed.value ?? [])
      .filter((address) => typeof address.address === 'string' && address.address !== '')
      .map((address) => ({
        address: address.address!,
        ...(address.name ? { name: address.name } : {}),
      }));
  });
}

// ---------------------------------------------------------------------------
// Lease and cursor
// ---------------------------------------------------------------------------

interface Cursor {
  lastUid: bigint;
  uidValidity: bigint | null;
}

/** Take the mailbox's lease, or null when another worker holds it. */
async function takeLease(mailbox: MailboxKey): Promise<Cursor | null> {
  const now = new Date();
  const where = { credentialId_folder: { credentialId: mailbox.credentialId, folder: mailbox.folder } };

  try {
    await prisma.mailFolder.upsert({ where, create: { ...mailbox }, update: {} });
  } catch {
    // Two workers created the row at once. One won, which is all the next
    // statement needs.
  }

  const { count } = await prisma.mailFolder.updateMany({
    where: { ...mailbox, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseOwner: WORKER_ID, lastPolledAt: now },
  });

  if (count !== 1) return null;

  const row = await prisma.mailFolder.findUnique({ where, select: { lastUid: true, uidValidity: true } });
  return { lastUid: row?.lastUid ?? 0n, uidValidity: row?.uidValidity ?? null };
}

async function releaseLease(mailbox: MailboxKey, cursor: Cursor | null, lastError: string | null): Promise<void> {
  await prisma.mailFolder.updateMany({
    // Only if we still hold it: a lease that expired mid-poll belongs to
    // someone else now, and writing our cursor over theirs would replay mail.
    where: { ...mailbox, leaseOwner: WORKER_ID },
    data: {
      leaseUntil: null,
      leaseOwner: null,
      lastError,
      ...(cursor ? { lastUid: cursor.lastUid, uidValidity: cursor.uidValidity } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A folder name can contain anything, so the two halves are length-prefixed
// rather than joined on a separator that a name could also hold.
function keyOf(mailbox: MailboxKey): string {
  return `${mailbox.credentialId.length}:${mailbox.credentialId}${mailbox.folder}`;
}

function parseKey(key: string): MailboxKey {
  const colon = key.indexOf(':');
  const length = Number(key.slice(0, colon));
  const rest = key.slice(colon + 1);
  return { credentialId: rest.slice(0, length), folder: rest.slice(length) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
