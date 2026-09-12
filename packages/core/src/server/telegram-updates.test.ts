import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowedUpdatesFor,
  describeUpdate,
  matchesTrigger,
  seedItemFor,
  type TelegramTriggerConfig,
  type TelegramUpdate,
} from './telegram-updates.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function message(text: string, chatId = 111, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 42,
      text,
      chat: { id: chatId, type: 'group' },
      from: { id: 7, username: 'someone' },
    },
  };
}

function buttonPress(data: string, chatId = 111): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: 'cbq_1',
      data,
      from: { id: 7 },
      message: { message_id: 42, chat: { id: chatId, type: 'private' } },
    },
  };
}

// ---------------------------------------------------------------------------
// Reading an update
// ---------------------------------------------------------------------------

test('describeUpdate lifts the chat and text out of a message', () => {
  const described = describeUpdate(message('hello'));

  assert.equal(described.kind, 'message');
  assert.equal(described.chatId, '111');
  assert.equal(described.chatType, 'group');
  assert.equal(described.messageId, 42);
  assert.equal(described.text, 'hello');
});

test('describeUpdate reads a button press from the callback query', () => {
  const described = describeUpdate(buttonPress('approve:9'));

  assert.equal(described.kind, 'callback_query');
  // The chat lives on the message the button is attached to, not on the query.
  assert.equal(described.chatId, '111');
  assert.equal(described.text, 'approve:9');
});

test('describeUpdate falls back to the caption when there is no text', () => {
  const update: TelegramUpdate = {
    update_id: 3,
    message: { message_id: 1, caption: 'a photo of a cat', chat: { id: 5, type: 'private' } },
  };

  assert.equal(describeUpdate(update).text, 'a photo of a cat');
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function matches(config: TelegramTriggerConfig, update: TelegramUpdate): boolean {
  return matchesTrigger(config, describeUpdate(update));
}

test('a trigger listening for messages ignores button presses', () => {
  assert.equal(matches({ updates: 'message' }, message('hi')), true);
  assert.equal(matches({ updates: 'message' }, buttonPress('x')), false);
  assert.equal(matches({ updates: 'callback_query' }, buttonPress('x')), true);
});

test('listening for everything takes any kind of update', () => {
  assert.equal(matches({ updates: 'all' }, message('hi')), true);
  assert.equal(matches({ updates: 'all' }, buttonPress('x')), true);
});

test('an empty chat allowlist means every chat', () => {
  assert.equal(matches({ chatIds: '' }, message('hi', 999)), true);
  assert.equal(matches({ chatIds: '111, 222' }, message('hi', 222)), true);
  assert.equal(matches({ chatIds: '111, 222' }, message('hi', 999)), false);
});

test('a command filter matches the first word only', () => {
  const config: TelegramTriggerConfig = { command: '/status' };

  assert.equal(matches(config, message('/status')), true);
  assert.equal(matches(config, message('/status now please')), true);
  assert.equal(matches(config, message('please /status')), false);
  assert.equal(matches(config, message('/statuses')), false);
});

test('a command filter ignores the bot name Telegram appends in groups', () => {
  assert.equal(matches({ command: '/status' }, message('/status@m8x_bot arg')), true);
});

test('two triggers on one bot each take the update they asked for', () => {
  // The fan-out, which is the point: sharing a bot is the supported
  // arrangement, so both filters are evaluated against the same update.
  const statusOnly: TelegramTriggerConfig = { command: '/status' };
  const everything: TelegramTriggerConfig = {};

  const status = message('/status');
  assert.deepEqual([matches(statusOnly, status), matches(everything, status)], [true, true]);

  const chatter = message('good morning');
  assert.deepEqual([matches(statusOnly, chatter), matches(everything, chatter)], [false, true]);
});

// ---------------------------------------------------------------------------
// allowed_updates
// ---------------------------------------------------------------------------

test('allowedUpdatesFor unions what every trigger on the bot asked for', () => {
  const allowed = allowedUpdatesFor([{ updates: 'message' }, { updates: 'callback_query' }]);

  assert.deepEqual([...allowed].sort(), ['callback_query', 'message']);
});

test('allowedUpdatesFor returns nothing when one trigger wants everything', () => {
  // Empty means "do not send allowed_updates", which is how Telegram spells
  // the default set. One greedy trigger must not narrow what the others get.
  assert.deepEqual(allowedUpdatesFor([{ updates: 'message' }, { updates: 'all' }]), []);
});

test('allowedUpdatesFor defaults to plain messages', () => {
  assert.deepEqual(allowedUpdatesFor([{}]), ['message']);
});

// ---------------------------------------------------------------------------
// The seed item
// ---------------------------------------------------------------------------

test('seedItemFor keeps the raw update and lifts the common fields', () => {
  const update = message('hello');
  const { json } = seedItemFor(update);

  assert.equal(json.chatId, '111');
  assert.equal(json.text, 'hello');
  assert.equal(json.messageId, 42);
  assert.equal(json.updateId, 1);
  // Nothing is dropped on the way through.
  assert.deepEqual(json.update, update);
});

test('seedItemFor exposes the callback query id a button reply needs', () => {
  const { json } = seedItemFor(buttonPress('approve:9'));

  assert.equal(json.callbackQueryId, 'cbq_1');
});

test('seedItemFor uses null rather than undefined for missing fields', () => {
  // Undefined would vanish when the item is stored as JSON, so an expression
  // reading $json.text would see nothing at all rather than an empty value.
  const { json } = seedItemFor({ update_id: 9, my_chat_member: {} });

  assert.equal(json.text, null);
  assert.equal(json.chatId, null);
});
