import { type NodeExecute } from '../../types.js';

/**
 * The response a webhook run sends back.
 *
 * The runner cannot answer an HTTP request — it does not know one is open, and
 * it may not even be in the same process. So this node writes the response as
 * its output and the ingress route, which is the only thing still holding the
 * request, reads it off the node's stored run.
 */
export const executeRespondToWebhook: NodeExecute = async (ctx) => {
  const contentType = ctx.getParam<string>('contentType') ?? 'application/json';
  const status = Math.trunc(Number(ctx.getParam('status') ?? 200));

  const headers: Record<string, string> = {};
  for (const row of ctx.getParam<Array<{ key?: unknown; value?: unknown }>>('headers') ?? []) {
    if (typeof row.key !== 'string' || row.key.trim() === '') continue;
    headers[row.key.trim().toLowerCase()] = String(row.value ?? '');
  }

  return [
    [
      {
        json: {
          status: Number.isFinite(status) && status >= 100 && status <= 599 ? status : 200,
          contentType,
          headers,
          body: ctx.getParam('body', 0) ?? null,
        },
      },
    ],
  ];
};
