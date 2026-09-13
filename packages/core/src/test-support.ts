import { runWorkflow, type RunEvent, type RunnerContext } from './runner/index.js';
import type { ExpressionScope } from './expressions.js';
import type { Graph, GraphEdge, GraphNode, Item } from './types.js';

/**
 * Builders the tests share.
 *
 * Not named `*.test.ts`, so the runner does not try to run it as a suite. It
 * holds no assertions on purpose: anything that checks behaviour belongs in the
 * file that tests that behaviour, not somewhere every suite drags in.
 */

/** A node whose id doubles as its name, which is all most tests need. */
export function node(
  id: string,
  type: string,
  params: Record<string, unknown> = {},
  x = 0,
  y = 0,
): GraphNode {
  return { id, type, name: id, position: { x, y }, params };
}

export function edge(source: string, target: string, sourceOutput = 0, targetInput = 0): GraphEdge {
  return { id: `${source}->${target}:${sourceOutput}`, source, sourceOutput, target, targetInput };
}

/** Run a graph with the injected halves stubbed out, and keep the events. */
export async function run(
  graph: Graph,
  seedItems: Item[] = [{ json: {} }],
  extra: Partial<RunnerContext> = {},
): Promise<{ result: Awaited<ReturnType<typeof runWorkflow>>; events: RunEvent[] }> {
  const events: RunEvent[] = [];
  const result = await runWorkflow({
    executionId: 'exec_test',
    workflowId: 'wf_test',
    mode: 'manual',
    graph,
    seedItems,
    signal: new AbortController().signal,
    loadCredential: async () => null,
    emit: (event) => {
      events.push(event);
    },
    ...extra,
  });
  return { result, events };
}

/** An expression scope holding one item, for the expression tests. */
export function scope(json: Record<string, unknown>): ExpressionScope {
  return {
    $json: json,
    $items: [{ json }],
    $index: 0,
    $node: {},
    $now: '2026-01-01T00:00:00.000Z',
    $env: {},
    $execution: { id: 'e', workflowId: 'w', mode: 'manual' },
  };
}
