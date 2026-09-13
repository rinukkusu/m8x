import assert from 'node:assert/strict';
import test from 'node:test';

import {
  anyWantsAttachmentBytes,
  matchesEmailTrigger,
  normaliseFolder,
  seedItemForEmail,
  wantsAttachmentBytes,
  type EmailTriggerConfig,
  type ParsedEmail,
} from './email-messages.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    uid: 12,
    messageId: '<abc@example.com>',
    subject: 'Invoice 2024-11',
    from: [{ name: 'Billing Team', address: 'billing@example.com' }],
    to: [{ address: 'me@example.org' }],
    cc: [],
    replyTo: [],
    date: '2024-11-02T09:30:00.000Z',
    text: 'Payment is due.',
    flags: [],
    attachments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('a trigger with no filters takes everything', () => {
  assert.equal(matchesEmailTrigger({}, email()), true);
});

test('subject filter matches on a case-insensitive substring', () => {
  assert.equal(matchesEmailTrigger({ subjectContains: 'invoice' }, email()), true);
  assert.equal(matchesEmailTrigger({ subjectContains: 'receipt' }, email()), false);
});

test('sender filter matches the display name as well as the address', () => {
  assert.equal(matchesEmailTrigger({ fromContains: 'billing@' }, email()), true);
  assert.equal(matchesEmailTrigger({ fromContains: 'Billing Team' }, email()), true);
  assert.equal(matchesEmailTrigger({ fromContains: 'someone else' }, email()), false);
});

test('sender filter checks every sender, not just the first', () => {
  const two = email({
    from: [
      { address: 'noreply@example.com' },
      { name: 'Bob', address: 'bob@example.com' },
    ],
  });
  assert.equal(matchesEmailTrigger({ fromContains: 'bob@' }, two), true);
});

test('unread-only skips a message the mailbox has flagged Seen', () => {
  const read = email({ flags: ['\\Seen'] });
  assert.equal(matchesEmailTrigger({ unseenOnly: true }, read), false);
  assert.equal(matchesEmailTrigger({ unseenOnly: false }, read), true);
  // The same message still reaches a second trigger that did not ask for
  // unread only, which is the point of filtering here rather than in the
  // IMAP search.
  assert.equal(matchesEmailTrigger({}, read), true);
});

test('blank filters are ignored rather than matching nothing', () => {
  assert.equal(matchesEmailTrigger({ subjectContains: '   ', fromContains: '' }, email()), true);
});

test('filters combine, so all of them have to pass', () => {
  const config: EmailTriggerConfig = { subjectContains: 'Invoice', fromContains: 'billing@' };
  assert.equal(matchesEmailTrigger(config, email()), true);
  assert.equal(matchesEmailTrigger(config, email({ subject: 'Receipt' })), false);
});

// ---------------------------------------------------------------------------
// Attachment intent
// ---------------------------------------------------------------------------

test('keeping the files is the default', () => {
  assert.equal(wantsAttachmentBytes({}), true);
  assert.equal(wantsAttachmentBytes({ attachments: 'store' }), true);
  assert.equal(wantsAttachmentBytes({ attachments: 'ignore' }), false);
});

test('the poller fetches bytes when any one trigger on the mailbox wants them', () => {
  assert.equal(anyWantsAttachmentBytes([{ attachments: 'ignore' }, { attachments: 'store' }]), true);
  assert.equal(anyWantsAttachmentBytes([{ attachments: 'ignore' }]), false);
  assert.equal(anyWantsAttachmentBytes([]), false);
});

// ---------------------------------------------------------------------------
// Folder
// ---------------------------------------------------------------------------

test('a blank folder means INBOX', () => {
  assert.equal(normaliseFolder(undefined), 'INBOX');
  assert.equal(normaliseFolder('  '), 'INBOX');
  assert.equal(normaliseFolder(' Archive/2024 '), 'Archive/2024');
});

// ---------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------

test('the item carries the first sender on its own for expressions', () => {
  const item = seedItemForEmail(email(), 'INBOX');
  assert.deepEqual(item.json.from, { name: 'Billing Team', address: 'billing@example.com' });
  assert.equal(Array.isArray(item.json.fromAll), true);
});

test('attachment metadata is present even when the bytes were not kept', () => {
  const item = seedItemForEmail(
    email({ attachments: [{ fileName: 'invoice.pdf', mimeType: 'application/pdf', size: 8123 }] }),
    'INBOX',
  );

  assert.deepEqual(item.json.attachments, [
    { fileName: 'invoice.pdf', mimeType: 'application/pdf', size: 8123 },
  ]);
  // No bytes were stored, so nothing claims to be attached.
  assert.equal(item.binary, undefined);
});

test('stored attachments are keyed by position and keep their reference', () => {
  const item = seedItemForEmail(email(), 'INBOX', [
    { mimeType: 'application/pdf', fileName: 'invoice.pdf', size: 8123, ref: 'bin_1' },
    { mimeType: 'image/png', fileName: 'logo.png', size: 400, ref: 'bin_2' },
  ]);

  assert.deepEqual(Object.keys(item.binary ?? {}), ['attachment_0', 'attachment_1']);
  assert.equal(item.binary?.attachment_0?.ref, 'bin_1');
  // The bytes are not in the item, which is the whole point of the store.
  assert.equal(item.binary?.attachment_0?.data, undefined);
});

test('a missing date and body become null rather than undefined', () => {
  // JSON drops undefined, and a field that vanishes from $json is far harder
  // to write an expression against than one that is null.
  const item = seedItemForEmail(email({ date: undefined, text: undefined, html: undefined }), 'INBOX');
  assert.equal(item.json.date, null);
  assert.equal(item.json.text, null);
  assert.equal(item.json.html, null);
});

test('the folder the message came from travels with it', () => {
  const item = seedItemForEmail(email(), 'Archive/2024');
  assert.equal(item.json.folder, 'Archive/2024');
});
