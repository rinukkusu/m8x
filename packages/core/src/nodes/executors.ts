import type { NodeDefinition, NodeExecute } from '../types.js';
import * as descriptors from './descriptors.js';
import { executeCode } from './impl/code.js';
import {
  executeFilter,
  executeIf,
  executeMerge,
  executeNoOp,
  executeSplitOut,
  executeStopAndError,
  executeSwitch,
  executeWait,
} from './impl/flow.js';
import { executeHttpRequest } from './impl/http-request.js';
import {
  executeAggregate,
  executeLimit,
  executeRemoveDuplicates,
  executeSort,
  executeSummarize,
} from './impl/items.js';
import { executeSet } from './impl/set.js';
import {
  executeTelegramAnswerCallbackQuery,
  executeTelegramApi,
  executeTelegramDeleteMessage,
  executeTelegramEditMessageText,
  executeTelegramSendDocument,
  executeTelegramSendMessage,
  executeTelegramSendPhoto,
} from './impl/telegram.js';
import { executePassThrough } from './impl/triggers.js';

/**
 * Descriptors joined to their behaviour.
 *
 * Only the runner imports this module. Everything the editor needs comes from
 * `./descriptors.js`, which is what keeps the Code node's child-process
 * sandbox and the HTTP client out of the browser bundle.
 */
const EXECUTORS: Record<string, NodeExecute> = {
  'trigger.manual': executePassThrough,
  'trigger.webhook': executePassThrough,
  'trigger.schedule': executePassThrough,
  'trigger.telegram': executePassThrough,
  'action.httpRequest': executeHttpRequest,
  'action.code': executeCode,
  'action.set': executeSet,
  'action.telegram.sendMessage': executeTelegramSendMessage,
  'action.telegram.sendPhoto': executeTelegramSendPhoto,
  'action.telegram.sendDocument': executeTelegramSendDocument,
  'action.telegram.editMessageText': executeTelegramEditMessageText,
  'action.telegram.deleteMessage': executeTelegramDeleteMessage,
  'action.telegram.answerCallbackQuery': executeTelegramAnswerCallbackQuery,
  'action.telegram.api': executeTelegramApi,
  'flow.if': executeIf,
  'flow.filter': executeFilter,
  'flow.switch': executeSwitch,
  'flow.merge': executeMerge,
  'flow.splitOut': executeSplitOut,
  'flow.aggregate': executeAggregate,
  'flow.summarize': executeSummarize,
  'flow.sort': executeSort,
  'flow.limit': executeLimit,
  'flow.removeDuplicates': executeRemoveDuplicates,
  'flow.wait': executeWait,
  'flow.noOp': executeNoOp,
  'flow.stopAndError': executeStopAndError,
};

const DEFINITIONS = new Map<string, NodeDefinition>(
  descriptors.NODE_DESCRIPTORS.map((descriptor) => [
    descriptor.type,
    { ...descriptor, execute: EXECUTORS[descriptor.type]! },
  ]),
);

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return DEFINITIONS.get(type);
}

/**
 * Throws rather than returning undefined. A graph referencing a node type that
 * no longer exists is a broken workflow, and failing loudly at the start of a
 * run beats silently skipping a step.
 */
export function requireNodeDefinition(type: string): NodeDefinition {
  const definition = DEFINITIONS.get(type);
  if (!definition) {
    throw new Error(
      `Unknown node type "${type}". It may come from a version of m8x that is no longer installed.`,
    );
  }
  return definition;
}
