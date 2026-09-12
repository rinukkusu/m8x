import { NodeError, type Item, type NodeExecute, type NodeExecuteContext } from '../../types.js';

/**
 * Every Telegram action node.
 *
 * Each Bot API method is its own node in the palette, but they are all the same
 * HTTP call with a different JSON body. So the transport lives here once and a
 * node is a `build` function turning parameters into that body. Those builders
 * are pure, which is the only part of this file that can be tested without a
 * network.
 */

/** Telegram's own limit is 60 seconds on getUpdates; sends are far quicker. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Enough of an error body to be useful, not enough to fill an execution row. */
const MAX_ERROR_CHARS = 500;

/**
 * Overridable for a local Bot API server, or an egress proxy on a network that
 * cannot reach Telegram directly.
 */
export function telegramApiBase(): string {
  const configured = process.env.M8X_TELEGRAM_API_BASE?.trim();
  return (configured && configured !== '' ? configured : 'https://api.telegram.org').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Reading parameters
// ---------------------------------------------------------------------------

/**
 * The parameter accessor a builder gets.
 *
 * Narrower than `ctx.getParam` on purpose: a builder should not be able to read
 * a credential or reach the abort signal, and the item index is already bound.
 */
export interface TelegramParams {
  /** Trimmed, or undefined when missing or blank. */
  text(name: string): string | undefined;
  /** Trimmed, or a ConfigurationError naming the field. */
  required(name: string, displayName: string): string;
  bool(name: string): boolean;
  /** Parsed, or undefined when blank. Throws when it is not valid JSON. */
  json(name: string, displayName: string): unknown;
}

export function paramsFor(ctx: NodeExecuteContext, index: number): TelegramParams {
  const text = (name: string): string | undefined => {
    const value = ctx.getParam(name, index);
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed === '' ? undefined : trimmed;
  };

  return {
    text,
    required(name, displayName) {
      const value = text(name);
      if (value === undefined) {
        throw new NodeError('ConfigurationError', `${displayName} is required.`, { param: name });
      }
      return value;
    },
    bool: (name) => ctx.getParam(name, index) === true,
    json(name, displayName) {
      const raw = ctx.getParam(name, index);
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw !== 'string') return raw;
      if (raw.trim() === '') return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        // Naming the field beats letting Telegram reject the whole call with a
        // generic "Bad Request", which says nothing about which box was wrong.
        throw new NodeError('ConfigurationError', `${displayName} is not valid JSON after expressions were resolved.`, {
          param: name,
          value: truncate(raw),
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

export type TelegramPayload = Record<string, unknown>;
export type TelegramPayloadBuilder = (p: TelegramParams) => TelegramPayload;

/** `none` is m8x's word for "send it as typed", which Telegram spells as absence. */
function formatting(p: TelegramParams): TelegramPayload {
  const mode = p.text('parseMode');
  return mode && mode !== 'none' ? { parse_mode: mode } : {};
}

function silently(p: TelegramParams): TelegramPayload {
  return p.bool('disableNotification') ? { disable_notification: true } : {};
}

/** The current shape. `reply_to_message_id` is the deprecated spelling. */
function threading(p: TelegramParams): TelegramPayload {
  const replyTo = p.text('replyToMessageId');
  return replyTo ? { reply_parameters: { message_id: Number(replyTo) } } : {};
}

function markup(p: TelegramParams): TelegramPayload {
  const value = p.json('replyMarkup', 'Reply markup');
  return value === undefined ? {} : { reply_markup: value };
}

function caption(p: TelegramParams): TelegramPayload {
  const value = p.text('caption');
  return value ? { caption: value, ...formatting(p) } : {};
}

export const buildSendMessage: TelegramPayloadBuilder = (p) => ({
  chat_id: p.required('chatId', 'Chat'),
  text: p.required('text', 'Text'),
  ...formatting(p),
  ...(p.bool('disableLinkPreview') ? { link_preview_options: { is_disabled: true } } : {}),
  ...silently(p),
  ...threading(p),
  ...markup(p),
});

export const buildSendPhoto: TelegramPayloadBuilder = (p) => ({
  chat_id: p.required('chatId', 'Chat'),
  photo: p.required('photo', 'Photo'),
  ...caption(p),
  ...silently(p),
  ...threading(p),
});

export const buildSendDocument: TelegramPayloadBuilder = (p) => ({
  chat_id: p.required('chatId', 'Chat'),
  document: p.required('document', 'Document'),
  ...caption(p),
  ...silently(p),
});

export const buildEditMessageText: TelegramPayloadBuilder = (p) => ({
  chat_id: p.required('chatId', 'Chat'),
  message_id: Number(p.required('messageId', 'Message')),
  text: p.required('text', 'Text'),
  ...formatting(p),
  ...markup(p),
});

export const buildDeleteMessage: TelegramPayloadBuilder = (p) => ({
  chat_id: p.required('chatId', 'Chat'),
  message_id: Number(p.required('messageId', 'Message')),
});

export const buildAnswerCallbackQuery: TelegramPayloadBuilder = (p) => {
  const notice = p.text('text');
  return {
    callback_query_id: p.required('callbackQueryId', 'Callback query'),
    ...(notice ? { text: notice } : {}),
    ...(p.bool('showAlert') ? { show_alert: true } : {}),
  };
};

/** The escape hatch: the author supplies the whole body and the method name. */
export const buildRawApiCall = (p: TelegramParams): { method: string; payload: TelegramPayload } => {
  const method = p.required('method', 'Method');
  const payload = p.json('payload', 'Payload') ?? {};

  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new NodeError('ConfigurationError', 'The payload must be a JSON object.', { param: 'payload' });
  }

  return { method, payload: payload as TelegramPayload };
};

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Turn a Telegram refusal into a NodeError.
 *
 * The error code goes in the type rather than the message so that failure
 * grouping separates a bad chat id from a revoked token, and so `isRetryable`
 * can tell a 429 from a 400.
 */
export function telegramFailure(method: string, status: number, body: unknown): NodeError {
  const shape = (body ?? {}) as { error_code?: unknown; description?: unknown; parameters?: unknown };
  const code = typeof shape.error_code === 'number' ? shape.error_code : status;
  const description = typeof shape.description === 'string' ? shape.description : `HTTP ${status}`;
  const retryAfter = (shape.parameters as { retry_after?: unknown } | undefined)?.retry_after;

  return new NodeError(`TelegramError${code}`, `${method} failed: ${description}`, {
    method,
    status: code,
    ...(typeof retryAfter === 'number' ? { retryAfter } : {}),
  });
}

async function callTelegram(
  ctx: NodeExecuteContext,
  method: string,
  payload: TelegramPayload,
): Promise<Record<string, unknown>> {
  const credential = await ctx.getCredential('credential');
  const token = credential?.botToken?.trim();

  if (!token) {
    throw new NodeError('ConfigurationError', 'No Telegram bot credential is selected on this node.');
  }

  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

  let response: Response;
  try {
    response = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (ctx.signal.aborted) throw new NodeError('CancelledError', 'The execution was cancelled.');
    // The token is in the URL, so the cause is deliberately not attached: a
    // fetch error can carry the request URL and this ends up in the database.
    throw new NodeError('TelegramNetworkError', `${method} could not reach Telegram.`, {
      method,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null;

  if (!response.ok || !body?.ok) throw telegramFailure(method, response.status, body);

  const result = body.result;
  // Most methods answer with an object; deleteMessage and friends answer `true`.
  return result && typeof result === 'object' ? (result as Record<string, unknown>) : { ok: result ?? true };
}

/**
 * A node that calls one Bot API method once per incoming item.
 *
 * Sequential, like the HTTP Request node and for the same reason: Telegram
 * rate-limits at roughly thirty messages a second overall and twenty a minute
 * per group, and a workflow that fans two hundred sends out in parallel is
 * asking for a 429 on most of them.
 */
function telegramNode(method: string, build: TelegramPayloadBuilder): NodeExecute {
  return async (ctx) => {
    const out: Item[] = [];

    for (let i = 0; i < ctx.items.length; i++) {
      const payload = build(paramsFor(ctx, i));
      out.push({ json: await callTelegram(ctx, method, payload) });
    }

    return [out];
  };
}

export const executeTelegramSendMessage = telegramNode('sendMessage', buildSendMessage);
export const executeTelegramSendPhoto = telegramNode('sendPhoto', buildSendPhoto);
export const executeTelegramSendDocument = telegramNode('sendDocument', buildSendDocument);
export const executeTelegramEditMessageText = telegramNode('editMessageText', buildEditMessageText);
export const executeTelegramDeleteMessage = telegramNode('deleteMessage', buildDeleteMessage);
export const executeTelegramAnswerCallbackQuery = telegramNode('answerCallbackQuery', buildAnswerCallbackQuery);

export const executeTelegramApi: NodeExecute = async (ctx) => {
  const out: Item[] = [];

  for (let i = 0; i < ctx.items.length; i++) {
    const { method, payload } = buildRawApiCall(paramsFor(ctx, i));
    out.push({ json: await callTelegram(ctx, method, payload) });
  }

  return [out];
};

function truncate(value: string): string {
  return value.length <= MAX_ERROR_CHARS ? value : `${value.slice(0, MAX_ERROR_CHARS)}…`;
}
