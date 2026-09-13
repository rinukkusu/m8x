import type { NodeDescriptor } from '../../types.js';

/** The email family: an IMAP trigger and SMTP sending. */

const EMAIL_COLOR = '#e8a33d';

export const emailTrigger: NodeDescriptor = {
  type: 'trigger.email',
  displayName: 'Email Trigger (IMAP)',
  description: 'Starts the workflow when a message arrives in a mailbox folder.',
  group: 'trigger',
  icon: 'Mail',
  color: EMAIL_COLOR,
  inputs: 0,
  outputs: [''],
  params: [
    {
      name: 'credential',
      displayName: 'IMAP account',
      type: 'string',
      credentialType: 'imap',
      required: true,
    },
    {
      name: 'folder',
      displayName: 'Folder',
      type: 'string',
      default: 'INBOX',
      placeholder: 'INBOX',
      description: 'Exactly as the server names it, e.g. INBOX, or INBOX/Invoices on some servers.',
      expression: false,
    },
    {
      name: 'unseenOnly',
      displayName: 'Only unread messages',
      type: 'boolean',
      default: false,
      description: 'Skips anything already marked read, including mail you opened yourself.',
    },
    {
      name: 'fromContains',
      displayName: 'Only from',
      type: 'string',
      placeholder: 'billing@',
      description: 'Optional. Matches part of the sender name or address.',
      expression: false,
    },
    {
      name: 'subjectContains',
      displayName: 'Only subjects containing',
      type: 'string',
      placeholder: 'Invoice',
      description: 'Optional.',
      expression: false,
    },
    {
      name: 'attachments',
      displayName: 'Attachments',
      type: 'select',
      default: 'store',
      options: [
        { label: 'Keep the files', value: 'store' },
        { label: 'Names and sizes only', value: 'ignore' },
      ],
      description: 'Metadata always arrives. Keeping the files stores them for nodes downstream to use.',
      expression: false,
    },
    {
      name: 'afterProcessing',
      displayName: 'After handling',
      type: 'select',
      default: 'nothing',
      options: [
        { label: 'Leave the mailbox alone', value: 'nothing' },
        { label: 'Mark the message read', value: 'seen' },
      ],
      description: 'A message is only ever handled once either way; this is about what your mail client shows.',
      expression: false,
    },
  ],
};

export const emailSend: NodeDescriptor = {
  type: 'action.email.send',
  displayName: 'Send Email',
  description: 'Sends a message over SMTP, once per incoming item.',
  group: 'action',
  icon: 'Send',
  color: EMAIL_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    {
      name: 'credential',
      displayName: 'SMTP account',
      type: 'string',
      credentialType: 'smtp',
      required: true,
    },
    {
      name: 'from',
      displayName: 'From',
      type: 'string',
      placeholder: 'Falls back to the credential default',
    },
    { name: 'to', displayName: 'To', type: 'string', required: true, placeholder: 'someone@example.com' },
    { name: 'cc', displayName: 'Cc', type: 'string' },
    { name: 'bcc', displayName: 'Bcc', type: 'string' },
    { name: 'replyTo', displayName: 'Reply-To', type: 'string' },
    { name: 'subject', displayName: 'Subject', type: 'string', placeholder: 'Order {{ $json.id }} shipped' },
    { name: 'text', displayName: 'Text body', type: 'text' },
    {
      name: 'html',
      displayName: 'HTML body',
      type: 'text',
      description: 'Optional. Sent alongside the text body, which stays the fallback for clients that want it.',
    },
    {
      name: 'attach',
      displayName: 'Attach files',
      type: 'string',
      placeholder: '* for all, or attachment_0, attachment_1',
      description:
        'Which of the incoming item\'s files to attach. Blank sends none. The Email Trigger names them attachment_0 upwards.',
    },
  ],
};
