import { NodeError, type Item, type NodeExecute, type NodeExecuteContext } from '../../types.js';
import { HTTP_METHODS_WITH_BODY as METHODS_WITH_BODY } from '../descriptors.js';

export const executeHttpRequest: NodeExecute = async (ctx) => {
    const out: Item[] = [];

    // One request per item. Sequential on purpose: a workflow that suddenly
    // fires two hundred parallel requests at someone's API is a good way to get
    // rate limited, and concurrency belongs in an explicit setting later.
    for (let i = 0; i < ctx.items.length; i++) {
      const method = ctx.getParam<string>('method', i) || 'GET';
      const rawUrl = ctx.getParam<string>('url', i);

      if (!rawUrl) {
        throw new NodeError('ConfigurationError', 'No URL is set on this node.');
      }

      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw new NodeError('ConfigurationError', `"${rawUrl}" is not a valid URL.`, { url: rawUrl });
      }

      for (const [key, value] of pairsOf(ctx.getParam('query', i))) {
        url.searchParams.append(key, value);
      }

      const headers = new Headers();
      for (const [key, value] of pairsOf(ctx.getParam('headers', i))) {
        headers.set(key, value);
      }

      const credential = await ctx.getCredential('credential');
      if (credential) applyAuth(headers, credential);

      const { body, contentType } = buildBody(ctx, i, method);
      if (contentType && !headers.has('content-type')) headers.set('content-type', contentType);

      const timeoutMs = Number(ctx.getParam('timeoutMs', i) ?? 30000);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([ctx.signal, timeout]);

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetch(url, { method, headers, body, signal, redirect: 'follow' });
      } catch (error) {
        if (timeout.aborted) {
          throw new NodeError('TimeoutError', `The request to ${url.host} timed out after ${timeoutMs}ms.`, {
            url: url.toString(),
            timeoutMs,
          });
        }
        if (ctx.signal.aborted) throw error;
        throw new NodeError(
          'ConnectionError',
          `Could not reach ${url.host}: ${error instanceof Error ? error.message : String(error)}`,
          { url: url.toString() },
        );
      }

      const responseType = ctx.getParam<string>('responseType', i) ?? 'auto';
      const payload = await readBody(response, responseType);

      if (!response.ok && ctx.getParam<boolean>('failOnErrorStatus', i) !== false) {
        // The status goes in the message so the fingerprint separates a 404
        // from a 500 on the same endpoint. They are different problems.
        throw new NodeError(
          `HttpError${response.status}`,
          `${method} ${url.pathname} returned ${response.status} ${response.statusText}`,
          { url: url.toString(), status: response.status, body: truncate(payload) },
        );
      }

      out.push({
        json: {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: payload,
          durationMs: Date.now() - startedAt,
        },
      });
    }

    return [out];
  };




function pairsOf(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is { key: string; value: unknown } =>
      Boolean(entry) && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string')
    .filter((entry) => entry.key.trim() !== '')
    .map((entry) => [entry.key, entry.value == null ? '' : String(entry.value)]);
}

function applyAuth(headers: Headers, credential: Record<string, string>): void {
  switch (credential.authType) {
    case 'bearer':
      headers.set('authorization', `Bearer ${credential.token ?? ''}`);
      break;
    case 'basic':
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${credential.username ?? ''}:${credential.password ?? ''}`).toString('base64')}`,
      );
      break;
    case 'header':
      if (credential.headerName) headers.set(credential.headerName, credential.headerValue ?? '');
      break;
    default:
      break;
  }
}

function buildBody(
  ctx: NodeExecuteContext,
  index: number,
  method: string,
): { body: string | undefined; contentType?: string } {
  if (!METHODS_WITH_BODY.includes(method)) return { body: undefined };

  const bodyType = ctx.getParam<string>('bodyType', index) ?? 'none';

  if (bodyType === 'json') {
    const raw = ctx.getParam('body', index);
    const serialised = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
    // Fail here rather than letting the server reject it, so the error names
    // the real cause.
    try {
      JSON.parse(serialised);
    } catch {
      throw new NodeError('ConfigurationError', 'The JSON body is not valid JSON after expressions were resolved.', {
        body: truncate(serialised),
      });
    }
    return { body: serialised, contentType: 'application/json' };
  }

  if (bodyType === 'form') {
    const form = new URLSearchParams();
    for (const [key, value] of pairsOf(ctx.getParam('formBody', index))) form.append(key, value);
    return { body: form.toString(), contentType: 'application/x-www-form-urlencoded' };
  }

  if (bodyType === 'raw') {
    const raw = ctx.getParam('body', index);
    return { body: typeof raw === 'string' ? raw : JSON.stringify(raw), contentType: 'text/plain' };
  }

  return { body: undefined };
}

async function readBody(response: Response, responseType: string): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  const wantsJson = responseType === 'json' || (responseType === 'auto' && contentType.includes('json'));

  const text = await response.text();
  if (!wantsJson) return text;

  try {
    return JSON.parse(text);
  } catch {
    // An endpoint that claims JSON and sends something else is common enough
    // that failing here would be unhelpful. Hand back the text.
    return text;
  }
}

function truncate(value: unknown, max = 2000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
