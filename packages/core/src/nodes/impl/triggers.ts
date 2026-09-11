import type { NodeExecute } from '../../types.js';

/**
 * Trigger nodes do not fetch anything themselves. The runner seeds the
 * execution with whatever started it (an empty item for a manual run, the
 * request payload for a webhook) and the trigger hands that on. Keeping the
 * shape uniform means downstream nodes cannot tell how the run began, which is
 * what lets you test a webhook workflow by clicking Run.
 */
export const executePassThrough: NodeExecute = async (ctx) => [ctx.items];
