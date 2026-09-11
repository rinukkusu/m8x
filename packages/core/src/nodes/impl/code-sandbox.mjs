/**
 * Child process that runs a Code node's user script.
 *
 * This file is spawned by `code.ts` with Node's permission model switched on,
 * so the script it evaluates cannot read or write the filesystem, spawn further
 * processes, or load native addons. That is the reason for the whole
 * out-of-process arrangement: `node:vm` shares a heap and a module registry
 * with the worker, so a script running there could reach the database client
 * and the credential key. A separate hardened process cannot.
 *
 * Known gap, stated plainly: Node's permission model does not cover the
 * network, so user code here can still make outbound requests. For a
 * single-team deployment where the threat model is mistakes rather than
 * attackers that is an acceptable trade, but it is not a claim of full
 * isolation.
 *
 * Protocol: one JSON request on stdin, one JSON response on stdout.
 */

let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', async () => {
  let response;
  try {
    response = { ok: true, value: await run(JSON.parse(raw)) };
  } catch (error) {
    response = {
      ok: false,
      error: {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        stack: cleanStack(error?.stack),
      },
    };
  }

  process.stdout.write(JSON.stringify(response), () => process.exit(response.ok ? 0 : 1));
});

async function run({ code, mode, items, context }) {
  const console = makeConsole();

  if (mode === 'eachItem') {
    const out = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const fn = compile(code, ['$json', '$item', '$index', '$items', '$node', '$now', '$env', 'console']);
      const result = await fn(item.json, item, index, items, context.$node, context.$now, context.$env, console);
      out.push(normaliseItem(result, item, index));
    }
    return { items: out, logs: console.$logs };
  }

  const fn = compile(code, ['$items', 'items', '$json', '$node', '$now', '$env', 'console']);
  const result = await fn(
    items,
    items,
    items[0]?.json ?? {},
    context.$node,
    context.$now,
    context.$env,
    console,
  );

  if (result === undefined || result === null) {
    throw new Error('The code returned nothing. Return an array of items, or an object.');
  }

  const list = Array.isArray(result) ? result : [result];
  return { items: list.map((entry, index) => normaliseItem(entry, items[index], index)), logs: console.$logs };
}

function compile(code, argNames) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    return new AsyncFunction(...argNames, `"use strict";\n${code}`);
  } catch (error) {
    const syntaxError = new Error(`The code has a syntax error: ${error.message}`);
    syntaxError.name = 'CodeSyntaxError';
    throw syntaxError;
  }
}

/**
 * Accept the shapes people actually write: a bare object, a `{ json }` item, or
 * a primitive. Being strict here just produces confusing errors for a node
 * whose whole point is convenience.
 */
function normaliseItem(value, fallback, index) {
  if (value === undefined || value === null) {
    return fallback ?? { json: {} };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { json: { value } };
  }
  if ('json' in value && value.json && typeof value.json === 'object') {
    return { json: value.json, ...(value.binary ? { binary: value.binary } : {}) };
  }
  if (index !== undefined && Object.keys(value).length === 0) {
    return { json: {} };
  }
  return { json: value };
}

function makeConsole() {
  const logs = [];
  const record = (level) => (...args) => {
    if (logs.length >= 200) return;
    logs.push({
      level,
      message: args.map(stringify).join(' '),
      at: new Date().toISOString(),
    });
  };

  return {
    $logs: logs,
    log: record('info'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Drop the frames that belong to this harness, keeping the user's own. */
function cleanStack(stack) {
  if (!stack) return undefined;
  return stack
    .split('\n')
    .filter((line) => !line.includes('code-sandbox.mjs'))
    .slice(0, 12)
    .join('\n');
}
