/**
 * The `{{ ... }}` expression language used in node parameters.
 *
 * This is a deliberately small interpreter rather than `eval` or `node:vm`.
 * Expressions come from workflow authors and run inside the worker process, so
 * handing them the real JS scope would mean any workflow could reach the
 * database connection and the credential key. A tiny language also stays
 * predictable, which matters more here than power: the escape hatch for
 * anything complicated is the Code node, which runs isolated.
 *
 * Supported: literals, member access, indexing, a whitelist of methods,
 * arithmetic, comparison, logical and ternary operators.
 * Not supported, on purpose: assignment, function definitions, `new`,
 * prototype access, and every global.
 */

import { NodeError } from './types.js';

export class ExpressionError extends NodeError {
  constructor(message: string) {
    super('ExpressionError', message);
    this.name = 'ExpressionError';
  }
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type TokenType = 'num' | 'str' | 'ident' | 'punct' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const PUNCTUATORS = [
  '===', '!==', '??', '&&', '||', '==', '!=', '<=', '>=',
  '(', ')', '[', ']', '.', ',', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':',
];

const QUOTES = new Set(['"', "'", '`']);

function tokenise(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      let j = i;
      let seenDot = false;
      while (j < src.length) {
        const digit = src[j]!;
        if (digit >= '0' && digit <= '9') {
          j++;
        } else if (digit === '_') {
          j++;
        } else if (digit === '.' && !seenDot) {
          // The second dot in `1.2.3` is member access on a number, not part of
          // the literal, and neither is a trailing one.
          seenDot = true;
          j++;
        } else {
          break;
        }
      }
      let raw = src.slice(i, j);
      if (raw.endsWith('.')) {
        raw = raw.slice(0, -1);
        j--;
      }
      tokens.push({ type: 'num', value: raw, pos: i });
      i = j;
      continue;
    }

    if (QUOTES.has(ch)) {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') {
          const next = src[j + 1];
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? '';
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new ExpressionError(`Unterminated string at ${i}`);
      tokens.push({ type: 'str', value: out, pos: i });
      i = j + 1;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }

    const punct = PUNCTUATORS.find((p) => src.startsWith(p, i));
    if (punct) {
      tokens.push({ type: 'punct', value: punct, pos: i });
      i += punct.length;
      continue;
    }

    throw new ExpressionError(`Unexpected character ${JSON.stringify(ch)} at ${i}`);
  }

  tokens.push({ type: 'eof', value: '', pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Node =
  | { kind: 'literal'; value: unknown }
  | { kind: 'var'; name: string }
  | { kind: 'member'; object: Node; property: Node }
  | { kind: 'call'; callee: Node; args: Node[] }
  | { kind: 'unary'; op: string; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'conditional'; test: Node; consequent: Node; alternate: Node }
  | { kind: 'array'; elements: Node[] };

// Binding powers. Higher binds tighter.
const BINARY_POWER: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4, '!=': 4, '===': 4, '!==': 4,
  '<': 5, '>': 5, '<=': 5, '>=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};

/**
 * How deeply expressions may nest.
 *
 * The parser is recursive descent, so nesting in the source becomes nesting on
 * the call stack: `((((((...1...))))))` or a run of unary operators recurses
 * once per level. Without a limit a pasted expression could take the worker
 * down with a stack overflow, which is an unhandleable crash rather than a
 * failed node. Real expressions are nowhere near this deep.
 */
const MAX_PARSE_DEPTH = 100;

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  /** Count one level of recursion in, and out again however the parse ends. */
  private nested<T>(parse: () => T): T {
    if (++this.depth > MAX_PARSE_DEPTH) {
      this.depth--;
      throw new ExpressionError('This expression nests too deeply to parse.');
    }
    try {
      return parse();
    } finally {
      this.depth--;
    }
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) {
      throw new ExpressionError(
        `Expected ${JSON.stringify(value)} at ${token.pos}, got ${JSON.stringify(token.value)}`,
      );
    }
  }

  parse(): Node {
    const node = this.parseExpression(0);
    if (this.peek().type !== 'eof') {
      throw new ExpressionError(`Unexpected trailing input at ${this.peek().pos}`);
    }
    return node;
  }

  private parseExpression(minPower: number): Node {
    return this.nested(() => this.parseExpressionInner(minPower));
  }

  private parseExpressionInner(minPower: number): Node {
    let left = this.parseUnary();

    for (;;) {
      const token = this.peek();

      if (token.type === 'punct' && token.value === '?' && minPower === 0) {
        this.next();
        const consequent = this.parseExpression(0);
        this.expect(':');
        const alternate = this.parseExpression(0);
        left = { kind: 'conditional', test: left, consequent, alternate };
        continue;
      }

      if (token.type !== 'punct') break;
      const power = BINARY_POWER[token.value];
      if (power === undefined || power < minPower) break;

      this.next();
      const right = this.parseExpression(power + 1);
      left = { kind: 'binary', op: token.value, left, right };
    }

    return left;
  }

  private parseUnary(): Node {
    const token = this.peek();
    if (token.type === 'punct' && (token.value === '!' || token.value === '-')) {
      this.next();
      return this.nested((): Node => ({ kind: 'unary', op: token.value, operand: this.parseUnary() }));
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(object: Node): Node {
    let node = object;

    for (;;) {
      const token = this.peek();
      if (token.type !== 'punct') break;

      if (token.value === '.') {
        this.next();
        const prop = this.next();
        if (prop.type !== 'ident') {
          throw new ExpressionError(`Expected a property name at ${prop.pos}`);
        }
        node = { kind: 'member', object: node, property: { kind: 'literal', value: prop.value } };
        continue;
      }

      if (token.value === '[') {
        this.next();
        const property = this.parseExpression(0);
        this.expect(']');
        node = { kind: 'member', object: node, property };
        continue;
      }

      if (token.value === '(') {
        this.next();
        const args: Node[] = [];
        if (this.peek().value !== ')') {
          for (;;) {
            args.push(this.parseExpression(0));
            if (this.peek().value !== ',') break;
            this.next();
          }
        }
        this.expect(')');
        node = { kind: 'call', callee: node, args };
        continue;
      }

      break;
    }

    return node;
  }

  private parsePrimary(): Node {
    const token = this.next();

    if (token.type === 'num') {
      return { kind: 'literal', value: Number(token.value.replace(/_/g, '')) };
    }
    if (token.type === 'str') return { kind: 'literal', value: token.value };

    if (token.type === 'ident') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      if (token.value === 'undefined') return { kind: 'literal', value: undefined };
      return { kind: 'var', name: token.value };
    }

    if (token.value === '(') {
      const node = this.parseExpression(0);
      this.expect(')');
      return node;
    }

    if (token.value === '[') {
      const elements: Node[] = [];
      if (this.peek().value !== ']') {
        for (;;) {
          elements.push(this.parseExpression(0));
          if (this.peek().value !== ',') break;
          this.next();
        }
      }
      this.expect(']');
      return { kind: 'array', elements };
    }

    throw new ExpressionError(`Unexpected token ${JSON.stringify(token.value)} at ${token.pos}`);
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Methods callable on a value. Anything not listed here is unreachable, which
 * is what keeps `constructor`, `bind` and friends out of the language.
 */
const ALLOWED_METHODS = new Set([
  // string
  'toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd', 'split',
  'replace', 'replaceAll', 'startsWith', 'endsWith', 'padStart', 'padEnd',
  'charAt', 'concat', 'repeat', 'at',
  // string and array
  'includes', 'indexOf', 'lastIndexOf', 'slice',
  // array
  'join', 'reverse', 'flat',
  // number
  'toFixed', 'toPrecision', 'toString',
]);

const SAFE_PROPERTIES = new Set(['length']);

function isForbiddenKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/**
 * Largest string an expression may build in one call.
 *
 * Three of the allowlisted methods take a length rather than returning
 * something bounded by their input, so `{{ "a".repeat(1e9) }}` asks for a
 * gigabyte and takes the worker, and every execution sharing it, down with an
 * out-of-memory kill. That is a whole-process failure caused by one node's
 * parameter, which is exactly what the rest of this file exists to avoid.
 * A megabyte is far beyond any legitimate use of these in a parameter; the Code
 * node is the escape hatch for anything larger.
 */
const MAX_BUILT_STRING = 1_000_000;

/**
 * Refuse a call that would allocate an absurd string, before it allocates it.
 * Checked rather than caught: by the time it throws, the memory is gone.
 */
function assertResultFits(name: string, target: unknown, args: unknown[]): void {
  if (name !== 'repeat' && name !== 'padStart' && name !== 'padEnd') return;

  const count = Number(args[0] ?? 0);
  if (!Number.isFinite(count) || count < 0) return;

  const size = name === 'repeat' ? String(target).length * count : count;
  if (size > MAX_BUILT_STRING) {
    throw new ExpressionError(
      `${name}() would build a string of ${Math.round(size).toLocaleString('en-US')} characters, past the ${MAX_BUILT_STRING.toLocaleString('en-US')} an expression may build.`,
    );
  }
}

export interface ExpressionScope {
  /** The current item's `json`. */
  $json: Record<string, unknown>;
  /** Output of already-run nodes, keyed by node name. */
  $node: Record<string, { json: Record<string, unknown>; items: unknown[] }>;
  /** Index of the current item. */
  $index: number;
  /** ISO timestamp of when the execution started. */
  $now: string;
  /** Whitelisted environment variables (M8X_VAR_* only). */
  $env: Record<string, string>;
  $execution: { id: string; workflowId: string; mode: string };
  /** All items on the node's input. */
  $items: unknown[];
}

function evaluate(node: Node, scope: ExpressionScope): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;

    case 'var': {
      // `in` would walk the prototype chain, so `constructor` and `toString`
      // would resolve to Object's own members instead of being unknown.
      if (!Object.hasOwn(scope, node.name)) {
        throw new ExpressionError(`Unknown variable ${node.name}`);
      }
      return (scope as unknown as Record<string, unknown>)[node.name];
    }

    case 'array':
      return node.elements.map((element) => evaluate(element, scope));

    case 'member': {
      const object = evaluate(node.object, scope);
      if (object === null || object === undefined) return undefined;

      const key = String(evaluate(node.property, scope));
      if (isForbiddenKey(key)) {
        throw new ExpressionError(`Access to ${key} is not allowed`);
      }

      if (typeof object === 'object') {
        return (object as Record<string, unknown>)[key];
      }

      // Primitives expose only whitelisted methods and `length`.
      if (SAFE_PROPERTIES.has(key) || ALLOWED_METHODS.has(key)) {
        return (object as unknown as Record<string, unknown>)[key];
      }
      return undefined;
    }

    case 'call': {
      if (node.callee.kind !== 'member') {
        throw new ExpressionError('Only method calls are supported');
      }
      const target = evaluate(node.callee.object, scope);
      const name = String(evaluate(node.callee.property, scope));

      if (!ALLOWED_METHODS.has(name)) {
        throw new ExpressionError(`Method ${name}() is not available in expressions`);
      }
      if (target === null || target === undefined) {
        throw new ExpressionError(`Cannot call ${name}() on ${String(target)}`);
      }

      const fn = (target as unknown as Record<string, unknown>)[name];
      if (typeof fn !== 'function') {
        throw new ExpressionError(`${name} is not a function here`);
      }

      const args = node.args.map((arg) => evaluate(arg, scope));
      assertResultFits(name, target, args);
      return (fn as (...a: unknown[]) => unknown).apply(target, args);
    }

    case 'unary': {
      const value = evaluate(node.operand, scope);
      return node.op === '!' ? !value : -(value as number);
    }

    case 'conditional':
      return evaluate(node.test, scope)
        ? evaluate(node.consequent, scope)
        : evaluate(node.alternate, scope);

    case 'binary': {
      // Short-circuit before touching the right-hand side.
      if (node.op === '&&') return evaluate(node.left, scope) && evaluate(node.right, scope);
      if (node.op === '||') return evaluate(node.left, scope) || evaluate(node.right, scope);
      if (node.op === '??') return evaluate(node.left, scope) ?? evaluate(node.right, scope);

      const left = evaluate(node.left, scope) as never;
      const right = evaluate(node.right, scope) as never;

      switch (node.op) {
        case '+': return (left as unknown as number) + (right as unknown as number);
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '%': return left % right;
        case '<': return left < right;
        case '>': return left > right;
        case '<=': return left <= right;
        case '>=': return left >= right;
        case '==': return left == right;
        case '!=': return left != right;
        case '===': return left === right;
        case '!==': return left !== right;
        default: throw new ExpressionError(`Unknown operator ${node.op}`);
      }
    }
  }
}

const astCache = new Map<string, Node>();

function parseCached(source: string): Node {
  const cached = astCache.get(source);
  if (cached) return cached;

  const ast = new Parser(tokenise(source)).parse();
  // Expressions are re-evaluated once per item, so caching the parse matters
  // on any workflow moving more than a handful of items.
  if (astCache.size > 5000) astCache.clear();
  astCache.set(source, ast);
  return ast;
}

/** Evaluate a single expression body, meaning the text between the braces. */
export function evaluateExpression(source: string, scope: ExpressionScope): unknown {
  return evaluate(parseCached(source), scope);
}

const TEMPLATE = /\{\{([\s\S]*?)\}\}/g;
const WHOLE_TEMPLATE = /^\s*\{\{([\s\S]*)\}\}\s*$/;

/**
 * Resolve `{{ }}` templates in a value.
 *
 * A string that is exactly one template keeps the expression's own type, so
 * `{{ $json.count }}` yields a number rather than the string "3". A template
 * with surrounding text is stringified and interpolated.
 */
export function resolveValue(value: unknown, scope: ExpressionScope): unknown {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE_TEMPLATE);
    if (whole && !whole[1]!.includes('{{')) return evaluateExpression(whole[1]!, scope);
    if (!value.includes('{{')) return value;

    return value.replace(TEMPLATE, (_match, body: string) => {
      const result = evaluateExpression(body, scope);
      if (result === null || result === undefined) return '';
      return typeof result === 'object' ? JSON.stringify(result) : String(result);
    });
  }

  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, scope));

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveValue(entry, scope);
    }
    return out;
  }

  return value;
}

/** True when the value contains anything the resolver would act on. */
export function hasExpression(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{');
  if (Array.isArray(value)) return value.some(hasExpression);
  if (value && typeof value === 'object') return Object.values(value).some(hasExpression);
  return false;
}
