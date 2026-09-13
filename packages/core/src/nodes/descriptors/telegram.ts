import type { NodeDescriptor, ParamSchema } from '../../types.js';

/**
 * The Telegram family: trigger, the Bot API methods worth a node of their own,
 * and a raw call for everything else.
 *
 * One descriptor per Bot API method rather than one node with an operation
 * dropdown. The palette then answers "can m8x send a photo?" by having a node
 * called Send Photo in it, and each node's inspector shows only the fields that
 * method actually takes.
 */

/** Telegram's own blue, so the family reads as one block in the palette. */
const TELEGRAM_COLOR = '#229ED9';

const telegramCredential: ParamSchema = {
  name: 'credential',
  displayName: 'Bot',
  type: 'select',
  credentialType: 'telegramApi',
  required: true,
  description: 'Several workflows can share one bot. They all receive its messages.',
  expression: false,
};

const telegramChatId: ParamSchema = {
  name: 'chatId',
  displayName: 'Chat',
  type: 'string',
  required: true,
  placeholder: '{{ $json.chatId }}',
  description: 'A numeric chat id, or @username for a public channel.',
};

/**
 * The credential and the chat, which every send node needs.
 *
 * Shared the way `conditionParams` is shared by If and Filter, so the two
 * fields cannot drift apart across eight nodes.
 */
export const telegramTarget: ParamSchema[] = [telegramCredential, telegramChatId];

const telegramParseMode: ParamSchema = {
  name: 'parseMode',
  displayName: 'Format',
  type: 'select',
  default: 'none',
  options: [
    { label: 'Plain text', value: 'none' },
    { label: 'Markdown', value: 'Markdown' },
    { label: 'MarkdownV2', value: 'MarkdownV2' },
    { label: 'HTML', value: 'HTML' },
  ],
  description:
    'MarkdownV2 rejects an unescaped . - ( ) ! and more, so text pasted in from an expression usually needs escaping. HTML is the forgiving one.',
  expression: false,
};

const telegramDisableNotification: ParamSchema = {
  name: 'disableNotification',
  displayName: 'Send silently',
  type: 'boolean',
  default: false,
  description: 'Delivers the message without a notification sound.',
  expression: false,
};

const telegramReplyTo: ParamSchema = {
  name: 'replyToMessageId',
  displayName: 'Reply to message',
  type: 'string',
  placeholder: '{{ $json.messageId }}',
  description: 'Optional. Threads this message under an existing one.',
};

const telegramReplyMarkup: ParamSchema = {
  name: 'replyMarkup',
  displayName: 'Reply markup',
  type: 'json',
  description:
    'Optional. An inline keyboard or a custom keyboard, as Telegram\'s reply_markup object. Pair it with an Answer Button node.',
  // Expressions are on so callback_data can carry the id the button acts on.
  expression: true,
};

export const telegramTrigger: NodeDescriptor = {
  type: 'trigger.telegram',
  displayName: 'Telegram Trigger',
  description: 'Starts the workflow when the bot receives a message.',
  group: 'trigger',
  icon: 'MessageCircle',
  color: TELEGRAM_COLOR,
  inputs: 0,
  outputs: [''],
  params: [
    telegramCredential,
    {
      name: 'updates',
      displayName: 'Listen for',
      type: 'select',
      default: 'message',
      options: [
        { label: 'Messages', value: 'message' },
        { label: 'Messages and edits', value: 'messageAndEdited' },
        { label: 'Button presses', value: 'callback_query' },
        { label: 'Channel posts', value: 'channel_post' },
        { label: 'Everything', value: 'all' },
      ],
      expression: false,
    },
    {
      name: 'chatIds',
      displayName: 'Only these chats',
      type: 'string',
      placeholder: '123456789, -1001234567890',
      description: 'Optional. A comma-separated allowlist of chat ids. Empty means every chat.',
      expression: false,
    },
    {
      name: 'command',
      displayName: 'Only this command',
      type: 'string',
      placeholder: '/status',
      description:
        'Optional. Fires only when the text starts with this. Point a second workflow at the same bot with a different command here.',
      expression: false,
    },
  ],
};

export const telegramSendMessage: NodeDescriptor = {
  type: 'action.telegram.sendMessage',
  displayName: 'Telegram Send Message',
  description: 'Sends a text message, once per incoming item.',
  group: 'action',
  icon: 'Send',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    { name: 'text', displayName: 'Text', type: 'text', required: true, placeholder: 'Order {{ $json.id }} shipped' },
    telegramParseMode,
    {
      name: 'disableLinkPreview',
      displayName: 'Hide link previews',
      type: 'boolean',
      default: false,
      expression: false,
    },
    telegramDisableNotification,
    telegramReplyTo,
    telegramReplyMarkup,
  ],
};

export const telegramSendPhoto: NodeDescriptor = {
  type: 'action.telegram.sendPhoto',
  displayName: 'Telegram Send Photo',
  description: 'Sends a photo by URL or by a file id Telegram already holds.',
  group: 'action',
  icon: 'Image',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    {
      name: 'photo',
      displayName: 'Photo',
      type: 'string',
      required: true,
      placeholder: 'https://example.com/chart.png',
      description: 'A public https URL, or a file_id from an earlier Telegram message.',
    },
    { name: 'caption', displayName: 'Caption', type: 'text' },
    telegramParseMode,
    telegramDisableNotification,
    telegramReplyTo,
  ],
};

export const telegramSendDocument: NodeDescriptor = {
  type: 'action.telegram.sendDocument',
  displayName: 'Telegram Send Document',
  description: 'Sends a file by URL or by a file id Telegram already holds.',
  group: 'action',
  icon: 'FileText',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    {
      name: 'document',
      displayName: 'Document',
      type: 'string',
      required: true,
      placeholder: 'https://example.com/report.pdf',
      description: 'A public https URL, or a file_id from an earlier Telegram message.',
    },
    { name: 'caption', displayName: 'Caption', type: 'text' },
    telegramParseMode,
    telegramDisableNotification,
  ],
};

export const telegramEditMessageText: NodeDescriptor = {
  type: 'action.telegram.editMessageText',
  displayName: 'Telegram Edit Message',
  description: 'Rewrites a message the bot already sent.',
  group: 'action',
  icon: 'SquarePen',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    { name: 'messageId', displayName: 'Message', type: 'string', required: true, placeholder: '{{ $json.message_id }}' },
    { name: 'text', displayName: 'Text', type: 'text', required: true },
    telegramParseMode,
    telegramReplyMarkup,
  ],
};

export const telegramDeleteMessage: NodeDescriptor = {
  type: 'action.telegram.deleteMessage',
  displayName: 'Telegram Delete Message',
  description: 'Deletes a message. Telegram only allows this for the last 48 hours.',
  group: 'action',
  icon: 'Trash2',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    { name: 'messageId', displayName: 'Message', type: 'string', required: true, placeholder: '{{ $json.messageId }}' },
  ],
};

export const telegramAnswerCallbackQuery: NodeDescriptor = {
  type: 'action.telegram.answerCallbackQuery',
  displayName: 'Telegram Answer Button',
  description: 'Acknowledges a button press. Without this the button spins until it times out.',
  group: 'action',
  icon: 'MousePointerClick',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    telegramCredential,
    {
      name: 'callbackQueryId',
      displayName: 'Callback query',
      type: 'string',
      required: true,
      placeholder: '{{ $json.callbackQueryId }}',
    },
    { name: 'text', displayName: 'Notice', type: 'string', description: 'Optional. Shown briefly to the person who pressed.' },
    {
      name: 'showAlert',
      displayName: 'Show as a dialog',
      type: 'boolean',
      default: false,
      description: 'A dialog they must dismiss, rather than a toast.',
      expression: false,
    },
  ],
};

export const telegramApi: NodeDescriptor = {
  type: 'action.telegram.api',
  displayName: 'Telegram API',
  description: 'Calls any Bot API method. The escape hatch for what the other nodes do not cover.',
  group: 'action',
  icon: 'Terminal',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    telegramCredential,
    {
      name: 'method',
      displayName: 'Method',
      type: 'string',
      required: true,
      placeholder: 'sendPoll',
      description: 'A Bot API method name, e.g. sendPoll or getChat.',
    },
    {
      name: 'payload',
      displayName: 'Payload',
      type: 'json',
      default: '{}',
      description: "The method's arguments, exactly as Telegram documents them.",
      expression: true,
    },
  ],
};
