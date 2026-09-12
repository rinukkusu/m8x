import type { Item, NodeExecute } from '../../types.js';
import { writePath } from '../paths.js';

export const executeSet: NodeExecute = async (ctx) => {
    const keepOnlySet = ctx.getParam<boolean>('keepOnlySet') === true;
    const out: Item[] = [];

    // An empty input still produces one item, so a Set node right after a
    // trigger can build a payload out of nothing.
    const items = ctx.items.length > 0 ? ctx.items : [{ json: {} } satisfies Item];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const assignments = ctx.getParam<unknown>('assignments', i);
      const json: Record<string, unknown> = keepOnlySet ? {} : { ...item.json };

      if (Array.isArray(assignments)) {
        for (const entry of assignments) {
          if (!entry || typeof entry !== 'object') continue;
          const { key, value } = entry as { key?: unknown; value?: unknown };
          if (typeof key !== 'string' || key.trim() === '') continue;
          // Dot notation writes nested, which is what people expect when they
          // type `customer.name` into the key field.
          writePath(json, key.trim(), value);
        }
      }

      out.push({ json, ...(item.binary ? { binary: item.binary } : {}) });
    }

    return [out];
  };
