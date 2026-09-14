import type { NodeDescriptor } from '../../types.js';
import { emailSend, emailTrigger } from './email.js';
import {
  aggregateNode,
  filterNode,
  ifNode,
  limitNode,
  loopOverItemsNode,
  mergeNode,
  noOpNode,
  removeDuplicatesNode,
  respondToWebhookNode,
  sortNode,
  splitOutNode,
  stopAndErrorNode,
  summarizeNode,
  switchNode,
  waitNode,
} from './flow.js';
import { code, executeWorkflowNode, httpRequest, setNode } from './actions.js';
import {
  datatableDelete,
  datatableGet,
  datatableInsert,
  datatableTrigger,
  datatableUpdate,
  datatableUpsert,
} from './datatable.js';
import { extractHtmlNode, parseCsvNode, toCsvNode, xmlToJsonNode } from './data.js';
import {
  telegramAnswerCallbackQuery,
  telegramApi,
  telegramDeleteMessage,
  telegramEditMessageText,
  telegramSendDocument,
  telegramSendMessage,
  telegramSendPhoto,
  telegramTrigger,
} from './telegram.js';
import { manualTrigger, scheduleTrigger, webhookTrigger } from './triggers.js';

/**
 * What every node looks like, with nothing about how it runs.
 *
 * The editor imports this directory and nothing else from the node layer. That
 * is the boundary that keeps `node:child_process` and the HTTP client out of
 * the browser bundle, and it is why the inspector panel can be generated
 * entirely from data.
 *
 * One file per area rather than one file for all of them: every integration
 * added is another few hundred lines, and they were all landing in the same
 * place. `NODE_DESCRIPTORS` below is the only list that has to be edited when a
 * node is added, and `executors.ts` refuses to load if it disagrees with the
 * executor table.
 */

export * from './shared.js';
export * from './actions.js';
export * from './data.js';
export * from './datatable.js';
export * from './email.js';
export * from './flow.js';
export * from './telegram.js';
export * from './triggers.js';

/** Palette order. Triggers first, then the things a workflow does with them. */
export const NODE_DESCRIPTORS: NodeDescriptor[] = [
  manualTrigger,
  webhookTrigger,
  scheduleTrigger,
  telegramTrigger,
  emailTrigger,
  datatableTrigger,
  httpRequest,
  code,
  setNode,
  executeWorkflowNode,
  respondToWebhookNode,
  parseCsvNode,
  toCsvNode,
  extractHtmlNode,
  xmlToJsonNode,
  datatableInsert,
  datatableGet,
  datatableUpdate,
  datatableUpsert,
  datatableDelete,
  telegramSendMessage,
  telegramSendPhoto,
  telegramSendDocument,
  telegramEditMessageText,
  telegramDeleteMessage,
  telegramAnswerCallbackQuery,
  telegramApi,
  emailSend,
  ifNode,
  filterNode,
  switchNode,
  mergeNode,
  splitOutNode,
  loopOverItemsNode,
  aggregateNode,
  summarizeNode,
  sortNode,
  limitNode,
  removeDuplicatesNode,
  waitNode,
  noOpNode,
  stopAndErrorNode,
];
