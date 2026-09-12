import type { Item } from '../types.js';

/**
 * Reading and filtering Telegram updates.
 *
 * Pure on purpose, and separate from the poller for it: deciding which triggers
 * want an update is the part with the interesting rules, and keeping it away
 * from the database means it can be tested directly.
 */

// ---------------------------------------------------------------------------
// Update shapes
//
// Only the fields the filters and the seed item need. Everything else rides
// along in the raw update.
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
  update_id: number;
  [key: string]: unknown;
}

interface TelegramChat {
  id?: unknown;
  type?: unknown;
}

interface TelegramMessage {
  message_id?: unknown;
  text?: unknown;
  caption?: unknown;
  chat?: TelegramChat;
  from?: unknown;
}

/** The update kinds a trigger can ask for, keyed by the node's `updates` param. */
const UPDATE_KINDS: Record<string, string[]> = {
  message: ['message'],
  messageAndEdited: ['message', 'edited_message'],
  callback_query: ['callback_query'],
  channel_post: ['channel_post', 'edited_channel_post'],
};

export interface TelegramTriggerConfig {
  credential?: unknown;
  updates?: unknown;
  chatIds?: unknown;
  command?: unknown;
}

export interface DescribedUpdate {
  kind: string;
  chatId?: string;
  chatType?: string;
  messageId?: number;
  text?: string;
  from?: unknown;
}

/** Pull the parts every filter and every seed item cares about. */
export function describeUpdate(update: TelegramUpdate): DescribedUpdate {
  const kind = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';

  if (kind === 'callback_query') {
    const query = (update.callback_query ?? {}) as { data?: unknown; from?: unknown; message?: TelegramMessage };
    const message = query.message ?? {};
    return {
      kind,
      chatId: idOf(message.chat?.id),
      chatType: typeof message.chat?.type === 'string' ? message.chat.type : undefined,
      messageId: typeof message.message_id === 'number' ? message.message_id : undefined,
      // The button's own payload is the closest thing to "what was said".
      text: typeof query.data === 'string' ? query.data : undefined,
      from: query.from,
    };
  }

  const message = (update[kind] ?? {}) as TelegramMessage;
  const body = typeof message.text === 'string' ? message.text : undefined;

  return {
    kind,
    chatId: idOf(message.chat?.id),
    chatType: typeof message.chat?.type === 'string' ? message.chat.type : undefined,
    messageId: typeof message.message_id === 'number' ? message.message_id : undefined,
    text: body ?? (typeof message.caption === 'string' ? message.caption : undefined),
    from: message.from,
  };
}

/**
 * Whether one trigger wants this update.
 *
 * Filtering here rather than in the node means an update nobody asked for never
 * becomes an execution row, so a busy group chat does not fill the history of a
 * workflow that only cares about one command.
 */
export function matchesTrigger(config: TelegramTriggerConfig, described: DescribedUpdate): boolean {
  const wanted = typeof config.updates === 'string' ? config.updates : 'message';
  if (wanted !== 'all') {
    const kinds = UPDATE_KINDS[wanted] ?? UPDATE_KINDS.message!;
    if (!kinds.includes(described.kind)) return false;
  }

  const allowlist = splitList(config.chatIds);
  if (allowlist.length > 0 && (!described.chatId || !allowlist.includes(described.chatId))) return false;

  const command = typeof config.command === 'string' ? config.command.trim() : '';
  if (command !== '') {
    const text = described.text?.trim() ?? '';
    // `/status@my_bot args` is the same command as `/status`, which matters in
    // groups, where Telegram clients add the bot name.
    const first = text.split(/\s+/, 1)[0]?.split('@', 1)[0] ?? '';
    if (first.toLowerCase() !== command.toLowerCase()) return false;
  }

  return true;
}

/**
 * What Telegram should send, across every trigger on this bot.
 *
 * The union, so adding a button trigger to one workflow cannot change what the
 * other workflows on the same bot receive. Empty means "ask for the default
 * set", which is what a trigger listening for everything wants.
 */
export function allowedUpdatesFor(configs: TelegramTriggerConfig[]): string[] {
  const kinds = new Set<string>();

  for (const config of configs) {
    const wanted = typeof config.updates === 'string' ? config.updates : 'message';
    if (wanted === 'all') return [];
    for (const kind of UPDATE_KINDS[wanted] ?? UPDATE_KINDS.message!) kinds.add(kind);
  }

  return [...kinds];
}

/**
 * The item the trigger node emits.
 *
 * The whole update is kept under `update` so nothing is lost, and the fields
 * every workflow reaches for are lifted to the top so `{{ $json.chatId }}`
 * works without digging through three levels of Telegram's shape.
 */
export function seedItemFor(update: TelegramUpdate): Item {
  const described = describeUpdate(update);

  return {
    json: {
      update,
      updateId: update.update_id,
      kind: described.kind,
      chatId: described.chatId ?? null,
      chatType: described.chatType ?? null,
      messageId: described.messageId ?? null,
      text: described.text ?? null,
      from: described.from ?? null,
      ...(described.kind === 'callback_query'
        ? { callbackQueryId: (update.callback_query as { id?: unknown } | undefined)?.id ?? null }
        : {}),
      receivedAt: new Date().toISOString(),
    },
  };
}


function idOf(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

function splitList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
