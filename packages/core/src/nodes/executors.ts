import type { NodeDefinition, NodeExecute } from '../types.js';
import * as descriptors from './descriptors.js';
import { executeCode } from './impl/code.js';
import { executeParseCsv, executeToCsv } from './impl/csv.js';
import { sendEmail } from './impl/email.js';
import {
  executeFilter,
  executeIf,
  executeLoopOverItems,
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
import { executeExtractHtml, executeXmlToJson } from './impl/markup.js';
import { executeRespondToWebhook } from './impl/respond.js';
import { executeSet } from './impl/set.js';
import { executeExecuteWorkflow } from './impl/sub-workflow.js';
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
  'trigger.email': executePassThrough,
  'action.email.send': sendEmail,
  'action.httpRequest': executeHttpRequest,
  'action.code': executeCode,
  'action.set': executeSet,
  'action.executeWorkflow': executeExecuteWorkflow,
  'action.respondToWebhook': executeRespondToWebhook,
  'action.parseCsv': executeParseCsv,
  'action.toCsv': executeToCsv,
  'action.extractHtml': executeExtractHtml,
  'action.xmlToJson': executeXmlToJson,
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
  'flow.loopOverItems': executeLoopOverItems,
  'flow.aggregate': executeAggregate,
  'flow.summarize': executeSummarize,
  'flow.sort': executeSort,
  'flow.limit': executeLimit,
  'flow.removeDuplicates': executeRemoveDuplicates,
  'flow.wait': executeWait,
  'flow.noOp': executeNoOp,
  'flow.stopAndError': executeStopAndError,
};

/**
 * Join the two halves, refusing to load if they do not line up.
 *
 * A descriptor whose type is missing from `EXECUTORS` would otherwise build a
 * definition with `execute: undefined` and fail as a `TypeError` partway
 * through a run, after the nodes before it had already fired their side
 * effects. An entry in `EXECUTORS` with no descriptor is the same mistake seen
 * from the other side: usually a typo in a type string, and one that leaves the
 * real node unwired. Both are wiring bugs, so both are caught at import.
 */
function buildDefinitions(): Map<string, NodeDefinition> {
  const definitions = new Map<string, NodeDefinition>();
  const unwired: string[] = [];

  for (const descriptor of descriptors.NODE_DESCRIPTORS) {
    const execute = EXECUTORS[descriptor.type];
    if (!execute) {
      unwired.push(descriptor.type);
      continue;
    }
    definitions.set(descriptor.type, { ...descriptor, execute });
  }

  const orphaned = Object.keys(EXECUTORS).filter((type) => !definitions.has(type));

  const problems = [
    unwired.length > 0 ? `no executor for ${unwired.join(', ')}` : '',
    orphaned.length > 0 ? `no descriptor for ${orphaned.join(', ')}` : '',
  ].filter((problem) => problem !== '');

  if (problems.length > 0) {
    throw new Error(`The node registry is inconsistent: ${problems.join('; ')}.`);
  }

  return definitions;
}

const DEFINITIONS = buildDefinitions();

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
