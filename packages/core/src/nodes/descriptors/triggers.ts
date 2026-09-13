import type { NodeDescriptor } from '../../types.js';

/**
 * The triggers that start a run without an integration behind them.
 *
 * Telegram and email have triggers too; they live with the rest of their node
 * family rather than here, so everything one integration adds sits together.
 */

export const manualTrigger: NodeDescriptor = {
  type: 'trigger.manual',
  displayName: 'Manual Trigger',
  description: 'Starts the workflow when you click Run.',
  group: 'trigger',
  icon: 'MousePointerClick',
  color: '#64748b',
  inputs: 0,
  outputs: [''],
  params: [],
};

export const webhookTrigger: NodeDescriptor = {
  type: 'trigger.webhook',
  displayName: 'Webhook',
  description: 'Starts the workflow when an HTTP request arrives.',
  group: 'trigger',
  icon: 'Webhook',
  color: '#0ea5e9',
  inputs: 0,
  outputs: [''],
  params: [
    {
      name: 'path',
      displayName: 'Path',
      type: 'string',
      required: true,
      placeholder: 'orders-created',
      description: 'The URL segment after /api/webhooks/. Letters, digits, dashes. Must be unique.',
      expression: false,
    },
    {
      name: 'method',
      displayName: 'Method',
      type: 'select',
      default: 'POST',
      options: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'ANY'].map((method) => ({
        label: method === 'ANY' ? 'Any' : method,
        value: method,
      })),
      expression: false,
    },
    {
      name: 'respond',
      displayName: 'Respond',
      type: 'select',
      default: 'immediately',
      description:
        'Immediately returns 202 and runs in the background. The other two hold the request open until the workflow finishes.',
      options: [
        { label: 'Immediately', value: 'immediately' },
        { label: 'When the workflow finishes', value: 'whenFinished' },
        { label: 'With a Respond to Webhook node', value: 'usingRespondNode' },
      ],
      expression: false,
    },
  ],
};

export const scheduleTrigger: NodeDescriptor = {
  type: 'trigger.schedule',
  displayName: 'Schedule',
  description: 'Starts the workflow on a timer.',
  group: 'trigger',
  icon: 'Clock',
  color: '#8b5cf6',
  inputs: 0,
  outputs: [''],
  params: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'select',
      default: 'interval',
      options: [
        { label: 'Every N minutes', value: 'interval' },
        { label: 'Cron expression', value: 'cron' },
      ],
      expression: false,
    },
    {
      name: 'intervalMinutes',
      displayName: 'Interval (minutes)',
      type: 'number',
      default: 15,
      showIf: { mode: ['interval'] },
      expression: false,
    },
    {
      name: 'cron',
      displayName: 'Cron',
      type: 'string',
      default: '0 * * * *',
      placeholder: '0 9 * * 1-5',
      description: 'Standard five-field cron, evaluated in the timezone below.',
      showIf: { mode: ['cron'] },
      expression: false,
    },
    {
      name: 'timezone',
      displayName: 'Timezone',
      type: 'string',
      default: 'UTC',
      placeholder: 'Europe/Berlin',
      showIf: { mode: ['cron'] },
      expression: false,
    },
  ],
};
