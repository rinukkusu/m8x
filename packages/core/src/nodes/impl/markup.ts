import * as cheerio from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { NodeError, type Item, type NodeExecute } from '../../types.js';

/**
 * HTML and XML, which are the two formats an API answers with when it does not
 * answer with JSON. Both parse server-side only: these nodes are reachable from
 * impl/, which the editor never imports.
 */

export const executeExtractHtml: NodeExecute = async (ctx) => {
  const take = ctx.getParam<string>('take') ?? 'text';
  const attribute = ctx.getParam<string>('attribute');
  const all = ctx.getParam<boolean>('all') === true;

  if (take === 'attribute' && !attribute) {
    throw new NodeError('ConfigurationError', 'No attribute to read is set on this node.');
  }

  const out: Item[] = [];

  for (let i = 0; i < ctx.items.length; i++) {
    const html = ctx.getParam<string>('html', i);
    if (typeof html !== 'string') throw new NodeError('DataError', 'There is no HTML to read here.');

    const $ = cheerio.load(html);
    const json: Record<string, unknown> = {};

    for (const row of ctx.getParam<Array<{ key?: unknown; value?: unknown }>>('extractions', i) ?? []) {
      const field = typeof row.key === 'string' ? row.key.trim() : '';
      const selector = typeof row.value === 'string' ? row.value.trim() : '';
      if (field === '' || selector === '') continue;

      const found = $(selector)
        .toArray()
        .map((element) => {
          const node = $(element);
          if (take === 'html') return node.html() ?? '';
          if (take === 'attribute') return node.attr(attribute!) ?? null;
          return node.text().trim();
        });

      // A field that found nothing is null rather than missing, so a downstream
      // expression reads as empty instead of throwing.
      json[field] = all ? found : (found[0] ?? null);
    }

    out.push({ json: { ...ctx.items[i]!.json, ...json }, binary: ctx.items[i]!.binary });
  }

  return [out];
};

export const executeXmlToJson: NodeExecute = async (ctx) => {
  const keepAttributes = ctx.getParam<boolean>('attributes') !== false;
  const outputField = (ctx.getParam<string>('outputField') ?? '').trim();

  const parser = new XMLParser({
    ignoreAttributes: !keepAttributes,
    attributeNamePrefix: '@',
    parseAttributeValue: true,
    trimValues: true,
  });

  const out: Item[] = [];

  for (let i = 0; i < ctx.items.length; i++) {
    const xml = ctx.getParam<string>('xml', i);
    if (typeof xml !== 'string') throw new NodeError('DataError', 'There is no XML to parse here.');

    // The parser is lenient and will happily make something up out of a
    // mismatched tag, which is worse than saying the document is broken.
    const valid = XMLValidator.validate(xml);
    if (valid !== true) {
      throw new NodeError('DataError', `That is not valid XML: ${valid.err.msg} (line ${valid.err.line}).`, {
        line: valid.err.line,
        code: valid.err.code,
      });
    }

    let parsed: unknown;
    try {
      parsed = parser.parse(xml);
    } catch (error) {
      throw new NodeError('DataError', `That is not valid XML: ${(error as Error).message}`);
    }

    const json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
    out.push({ json: outputField === '' ? json : { ...ctx.items[i]!.json, [outputField]: json } });
  }

  return [out];
};
