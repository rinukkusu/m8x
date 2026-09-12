import { NodeError, type Item, type NodeExecute, type NodeExecuteContext } from '../../types.js';

export const executeExecuteWorkflow: NodeExecute = async (ctx) => {
  const wait = ctx.getParam<boolean>('waitForCompletion') !== false;

  if (ctx.getParam<string>('mode') !== 'perItem') {
    return [await ctx.executeWorkflow(workflowId(ctx, 0), ctx.items, { wait })];
  }

  // Sequential rather than all at once: 500 items must not open 500 concurrent
  // runs, each holding a worker while it waits on its own children.
  const out: Item[] = [];
  for (let i = 0; i < ctx.items.length; i++) {
    out.push(...(await ctx.executeWorkflow(workflowId(ctx, i), [ctx.items[i]!], { wait })));
  }
  return [out];
};

function workflowId(ctx: NodeExecuteContext, itemIndex: number): string {
  const id = ctx.getParam<string>('workflowId', itemIndex);
  if (typeof id !== 'string' || id.trim() === '') {
    throw new NodeError('ConfigurationError', 'No workflow to run is set on this node.');
  }
  return id.trim();
}
