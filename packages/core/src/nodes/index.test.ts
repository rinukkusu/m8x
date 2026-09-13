import assert from 'node:assert/strict';
import test from 'node:test';

import { NODE_DESCRIPTORS, resolveOutputs } from './index.js';
import type { NodeDescriptor } from '../types.js';

/** The metadata helpers the editor and the runner both read. */

const branching: NodeDescriptor = {
  type: 'test.branching',
  displayName: 'Branching',
  description: 'A node whose branches follow its rules.',
  group: 'flow',
  icon: 'GitBranch',
  color: '#000000',
  inputs: 1,
  outputs: ['unconfigured'],
  outputsFrom: 'rules',
  params: [],
};

test('branch labels come from the rules that define them', () => {
  assert.deepEqual(
    resolveOutputs(branching, { rules: [{ key: 'paid', value: '' }, { key: 'refunded', value: '' }] }),
    ['paid', 'refunded'],
  );
});

test('a rule with no label still gets a branch, so the wiring survives', () => {
  assert.deepEqual(resolveOutputs(branching, { rules: [{ key: '', value: '' }] }), ['Branch 1']);
});

test('an unconfigured node falls back to its declared outputs', () => {
  assert.deepEqual(resolveOutputs(branching, {}), ['unconfigured']);
  assert.deepEqual(resolveOutputs(branching, { rules: [] }), ['unconfigured']);
});

test('the fallback branch is appended last', () => {
  assert.deepEqual(
    resolveOutputs(branching, { rules: [{ key: 'paid', value: '' }], fallback: true }),
    ['paid', 'fallback'],
  );
});

// ---------------------------------------------------------------------------
// Registry consistency
// ---------------------------------------------------------------------------

test('every descriptor has an executor, and every executor a descriptor', async () => {
  // Importing is the assertion: executors.ts refuses to load when the two
  // halves disagree. Checking it here means a node added with no executor
  // fails in the suite rather than partway through someone's first run of it.
  const { getNodeDefinition } = await import('./executors.js');
  const { NODE_DESCRIPTORS } = await import('./descriptors/index.js');

  assert.ok(NODE_DESCRIPTORS.length > 0);
  for (const descriptor of NODE_DESCRIPTORS) {
    assert.equal(
      typeof getNodeDefinition(descriptor.type)?.execute,
      'function',
      `${descriptor.type} has no executor`,
    );
  }
});

test('no two nodes share a type, and none shares a display name', () => {
  const types = new Set<string>();
  const names = new Set<string>();

  for (const descriptor of NODE_DESCRIPTORS) {
    assert.equal(types.has(descriptor.type), false, `${descriptor.type} is declared twice`);
    types.add(descriptor.type);

    // Two nodes with one name is not fatal, but the palette becomes a guess.
    assert.equal(names.has(descriptor.displayName), false, `two nodes are called ${descriptor.displayName}`);
    names.add(descriptor.displayName);
  }
});

test('a branch label is never repeated within one node', () => {
  for (const descriptor of NODE_DESCRIPTORS) {
    // Stop and Error is the one node with no outputs: nothing follows a
    // deliberate failure, so it has nothing to label.
    const labels = new Set(descriptor.outputs);
    assert.equal(
      labels.size,
      descriptor.outputs.length,
      `${descriptor.type} repeats a branch label: ${descriptor.outputs.join(', ')}`,
    );
  }
});

test('a trigger takes no input and everything else takes at least one', () => {
  for (const descriptor of NODE_DESCRIPTORS) {
    if (descriptor.group === 'trigger') {
      assert.equal(descriptor.inputs, 0, `${descriptor.type} is a trigger with an input`);
    } else {
      assert.ok(descriptor.inputs >= 1, `${descriptor.type} takes no input`);
    }
  }
});
