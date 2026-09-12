import type { NodeDescriptor, ParamSchema } from '../types.js';
import { NODE_DESCRIPTORS } from './descriptors.js';

/**
 * The client-safe node surface: metadata and the helpers that read it.
 *
 * Nothing here imports a Node.js builtin or a node's behaviour, so the editor
 * can render the palette, generate every inspector panel and validate a graph
 * without pulling the execution code into the browser.
 */

const REGISTRY = new Map(NODE_DESCRIPTORS.map((descriptor) => [descriptor.type, descriptor]));

export function getNodeDescriptor(type: string): NodeDescriptor | undefined {
  return REGISTRY.get(type);
}

export function isTriggerNode(type: string): boolean {
  return getNodeDescriptor(type)?.group === 'trigger';
}

/** Defaults for a freshly dropped node, taken from the parameter schema. */
export function defaultParams(descriptor: NodeDescriptor): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const schema of descriptor.params) {
    if (schema.default !== undefined) params[schema.name] = structuredClone(schema.default);
  }
  return params;
}

/**
 * Whether a parameter should be shown, given the current values of its
 * siblings. The inspector panel and the runner both use this, so they can never
 * disagree about which fields are actually in play.
 */
export function isParamVisible(schema: ParamSchema, params: Record<string, unknown>): boolean {
  if (!schema.showIf) return true;
  return Object.entries(schema.showIf).every(([name, allowed]) => allowed.includes(params[name]));
}

/**
 * The output branches a node actually has, which for a Switch depends on how
 * many rules its author wrote.
 *
 * The canvas draws handles from this and the runner pads its output to it, so
 * the two can never disagree about how many branches exist — the same reason
 * `isParamVisible` is shared rather than reimplemented on each side.
 */
export function resolveOutputs(
  descriptor: NodeDescriptor,
  params: Record<string, unknown>,
): string[] {
  if (!descriptor.outputsFrom) return descriptor.outputs;

  const rows = params[descriptor.outputsFrom];
  if (!Array.isArray(rows)) return descriptor.outputs;

  const labels = rows.map((row, index) => {
    const key = (row as { key?: unknown } | null)?.key;
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : `Branch ${index + 1}`;
  });

  if (labels.length === 0) return descriptor.outputs;
  if (params.fallback === true) labels.push('fallback');
  return labels;
}

/** Whether `{{ }}` templates are resolved for this parameter. */
export function paramUsesExpressions(schema: ParamSchema): boolean {
  if (schema.expression !== undefined) return schema.expression;
  return (
    schema.type === 'string' ||
    schema.type === 'text' ||
    schema.type === 'number' ||
    schema.type === 'keyValue'
  );
}

export interface ParamIssue {
  nodeId: string;
  param: string;
  message: string;
}

/** Required-parameter check, run before an execution starts. */
export function validateParams(
  nodeId: string,
  descriptor: NodeDescriptor,
  params: Record<string, unknown>,
): ParamIssue[] {
  const issues: ParamIssue[] = [];

  for (const schema of descriptor.params) {
    if (!schema.required || !isParamVisible(schema, params)) continue;
    const value = params[schema.name];
    if (value === undefined || value === null || value === '') {
      issues.push({ nodeId, param: schema.name, message: `${schema.displayName} is required.` });
    }
  }

  return issues;
}

export { NODE_DESCRIPTORS, COMPARISON_OPERATORS, conditionParams } from './descriptors.js';
