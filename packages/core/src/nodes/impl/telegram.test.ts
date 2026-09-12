import assert from 'node:assert/strict';
import test from 'node:test';

import { NodeError } from '../../types.js';
import {
  buildAnswerCallbackQuery,
  buildDeleteMessage,
  buildEditMessageText,
  buildRawApiCall,
  buildSendDocument,
  buildSendMessage,
  buildSendPhoto,
  telegramFailure,
  type TelegramParams,
} from './telegram.js';

/**
 * The builders take the same accessor the runner hands them, so a plain object
 * of parameter values is enough to drive one. Nothing here touches a network.
 */
function params(values: Record<string, unknown>): TelegramParams {
  const text = (name: string): string | undefined => {
    const value = values[name];
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed === '' ? undefined : trimmed;
  };

  return {
    text,
    required(name, displayName) {
      const value = text(name);
      if (value === undefined) throw new NodeError('ConfigurationError', `${displayName} is required.`);
      return value;
    },
    bool: (name) => values[name] === true,
    json(name, displayName) {
      const raw = values[name];
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw !== 'string') return raw;
      if (raw.trim() === '') return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        throw new NodeError('ConfigurationError', `${displayName} is not valid JSON.`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

test('sendMessage sends only the fields that were filled in', () => {
  const payload = buildSendMessage(params({ chatId: '111', text: 'hello' }));

  assert.deepEqual(payload, { chat_id: '111', text: 'hello' });
});

test('sendMessage omits parse_mode for plain text', () => {
  // `none` is m8x's word for "as typed", and Telegram spells that as absence.
  const plain = buildSendMessage(params({ chatId: '1', text: 'x', parseMode: 'none' }));
  assert.equal('parse_mode' in plain, false);

  const markdown = buildSendMessage(params({ chatId: '1', text: 'x', parseMode: 'MarkdownV2' }));
  assert.equal(markdown.parse_mode, 'MarkdownV2');
});

test('sendMessage uses the current spellings for replies and link previews', () => {
  const payload = buildSendMessage(
    params({ chatId: '1', text: 'x', replyToMessageId: '42', disableLinkPreview: true, disableNotification: true }),
  );

  assert.deepEqual(payload.reply_parameters, { message_id: 42 });
  assert.deepEqual(payload.link_preview_options, { is_disabled: true });
  assert.equal(payload.disable_notification, true);
});

test('sendMessage parses an inline keyboard out of the reply markup', () => {
  const keyboard = { inline_keyboard: [[{ text: 'Approve', callback_data: 'approve:9' }]] };
  const payload = buildSendMessage(params({ chatId: '1', text: 'x', replyMarkup: JSON.stringify(keyboard) }));

  assert.deepEqual(payload.reply_markup, keyboard);
});

test('a missing required field fails as configuration, not as a Telegram error', () => {
  // ConfigurationError is the one the runner refuses to retry, which is right:
  // an empty chat box will still be empty on the third attempt.
  assert.throws(() => buildSendMessage(params({ text: 'hello' })), (error: unknown) => {
    assert.ok(error instanceof NodeError);
    assert.equal(error.errorType, 'ConfigurationError');
    assert.match(error.message, /Chat is required/);
    return true;
  });
});

test('broken JSON in the reply markup names the field', () => {
  assert.throws(
    () => buildSendMessage(params({ chatId: '1', text: 'x', replyMarkup: '{ not json' })),
    /Reply markup is not valid JSON/,
  );
});

test('a caption carries the format, and no caption means no format', () => {
  const withCaption = buildSendPhoto(params({ chatId: '1', photo: 'https://x/y.png', caption: '*hi*', parseMode: 'Markdown' }));
  assert.equal(withCaption.caption, '*hi*');
  assert.equal(withCaption.parse_mode, 'Markdown');

  const without = buildSendPhoto(params({ chatId: '1', photo: 'https://x/y.png', parseMode: 'Markdown' }));
  assert.equal('caption' in without, false);
  assert.equal('parse_mode' in without, false);
});

test('sendDocument takes a URL or a file id in the same field', () => {
  assert.equal(buildSendDocument(params({ chatId: '1', document: 'BQACAgIAAx0' })).document, 'BQACAgIAAx0');
});

test('message ids are sent as numbers', () => {
  // Telegram rejects a string here, and the id arrives from a text input.
  assert.equal(buildEditMessageText(params({ chatId: '1', messageId: '42', text: 'x' })).message_id, 42);
  assert.equal(buildDeleteMessage(params({ chatId: '1', messageId: '42' })).message_id, 42);
});

test('answering a button press needs only the query id', () => {
  assert.deepEqual(buildAnswerCallbackQuery(params({ callbackQueryId: 'cbq_1' })), {
    callback_query_id: 'cbq_1',
  });

  const loud = buildAnswerCallbackQuery(params({ callbackQueryId: 'cbq_1', text: 'Done', showAlert: true }));
  assert.equal(loud.text, 'Done');
  assert.equal(loud.show_alert, true);
});

test('the raw API node passes the payload through untouched', () => {
  const { method, payload } = buildRawApiCall(
    params({ method: 'sendPoll', payload: '{"chat_id":"1","question":"Tea?","options":["yes","no"]}' }),
  );

  assert.equal(method, 'sendPoll');
  assert.deepEqual(payload, { chat_id: '1', question: 'Tea?', options: ['yes', 'no'] });
});

test('the raw API node refuses a payload that is not an object', () => {
  assert.throws(() => buildRawApiCall(params({ method: 'sendPoll', payload: '[1,2]' })), /must be a JSON object/);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('a Telegram refusal carries its code in the error type', () => {
  // The code is in the type rather than the message so that failure grouping
  // separates a bad chat id from a revoked token.
  const error = telegramFailure('sendMessage', 400, {
    ok: false,
    error_code: 400,
    description: 'Bad Request: chat not found',
  });

  assert.equal(error.errorType, 'TelegramError400');
  assert.match(error.message, /chat not found/);
  assert.equal(error.details.method, 'sendMessage');
});

test('a rate limit keeps the retry_after Telegram asked for', () => {
  const error = telegramFailure('sendMessage', 429, {
    ok: false,
    error_code: 429,
    description: 'Too Many Requests',
    parameters: { retry_after: 17 },
  });

  assert.equal(error.errorType, 'TelegramError429');
  assert.equal(error.details.retryAfter, 17);
});

test('a response with no JSON body still names the status', () => {
  const error = telegramFailure('sendMessage', 502, null);

  assert.equal(error.errorType, 'TelegramError502');
  assert.match(error.message, /HTTP 502/);
});
