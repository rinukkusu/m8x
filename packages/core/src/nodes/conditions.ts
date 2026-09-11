import { NodeError, type NodeExecuteContext } from '../types.js';

const UNARY_OPERATORS = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

export function evaluateCondition(ctx: NodeExecuteContext, itemIndex: number): boolean {
  const mode = ctx.getParam<string>('conditionMode', itemIndex) ?? 'comparison';

  if (mode === 'expression') {
    return Boolean(ctx.getParam('expression', itemIndex));
  }

  const operator = ctx.getParam<string>('operator', itemIndex) ?? 'equals';
  const left = ctx.getParam('left', itemIndex);
  const right = UNARY_OPERATORS.has(operator) ? undefined : ctx.getParam('right', itemIndex);

  return compare(left, operator, right);
}

export function compare(left: unknown, operator: string, right: unknown): boolean {
  switch (operator) {
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'isTrue':
      return left === true || left === 'true';
    case 'isFalse':
      return left === false || left === 'false';

    case 'equals':
      return looseEquals(left, right);
    case 'notEquals':
      return !looseEquals(left, right);

    case 'contains':
      return asText(left).includes(asText(right));
    case 'notContains':
      return !asText(left).includes(asText(right));
    case 'startsWith':
      return asText(left).startsWith(asText(right));
    case 'endsWith':
      return asText(left).endsWith(asText(right));

    case 'regex':
      try {
        return new RegExp(asText(right)).test(asText(left));
      } catch (error) {
        throw new NodeError('ConfigurationError', `"${asText(right)}" is not a valid regular expression.`, {
          cause: error instanceof Error ? error.message : String(error),
        });
      }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(left);
      const b = asNumber(right);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        // Silently returning false here would look like a data problem rather
        // than a configuration one, which is much harder to debug from the
        // failures page.
        throw new NodeError(
          'ComparisonError',
          `Cannot compare ${JSON.stringify(left)} and ${JSON.stringify(right)} numerically.`,
          { left, right, operator },
        );
      }
      if (operator === 'gt') return a > b;
      if (operator === 'gte') return a >= b;
      if (operator === 'lt') return a < b;
      return a <= b;
    }

    default:
      throw new NodeError('ConfigurationError', `Unknown operator "${operator}".`);
  }
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * "5" and 5 compare equal. Values arriving from a webhook body or a query
 * string are strings far more often than not, and strict equality here would
 * make the If node feel broken.
 */
function looseEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) {
    return isEmpty(left) && isEmpty(right);
  }
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return String(left) === String(right);
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}
