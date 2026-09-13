import { NodeError, type Item, type NodeExecute, type NodeExecuteContext } from '../../types.js';
import { HTTP_METHODS_WITH_BODY as METHODS_WITH_BODY } from '../descriptors/index.js';
import { resolveTimeout } from '../params.js';

/** Ten minutes. Past that the workflow wants a queue, not a longer timeout. */
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How much of a response body is read before giving up.
 *
 * The body ends up in an item, an execution row and the run detail view, so a
 * large download is never useful here, and reading it in full would take the
 * worker's memory with it.
 */
const MAX_RESPONSE_BYTES = 16_000_000;

/** Redirect hops to follow before calling it a loop. */
const MAX_REDIRECTS = 5;

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
      const authHeaders = credential ? applyAuth(headers, credential) : [];

      const { body, contentType } = buildBody(ctx, i, method);
      if (contentType && !headers.has('content-type')) headers.set('content-type', contentType);

      const timeoutMs = resolveTimeout(ctx.getParam('timeoutMs', i), 30_000, MAX_TIMEOUT_MS);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([ctx.signal, timeout]);

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await send({ url, method, headers, body, signal, authHeaders });
      } catch (error) {
        if (timeout.aborted) {
          throw new NodeError('TimeoutError', `The request to ${url.host} timed out after ${timeoutMs}ms.`, {
            url: url.toString(),
            timeoutMs,
          });
        }
        if (ctx.signal.aborted) throw error;
        // A redirect loop or an oversized response is already described.
        if (error instanceof NodeError) throw error;
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

/** Applies the credential and names the headers it wrote, so a redirect to another origin can drop them. */
function applyAuth(headers: Headers, credential: Record<string, string>): string[] {
  switch (credential.authType) {
    case 'bearer':
      headers.set('authorization', `Bearer ${credential.token ?? ''}`);
      return ['authorization'];
    case 'basic':
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${credential.username ?? ''}:${credential.password ?? ''}`).toString('base64')}`,
      );
      return ['authorization'];
    case 'header':
      if (!credential.headerName) return [];
      headers.set(credential.headerName, credential.headerValue ?? '');
      return [credential.headerName];
    default:
      return [];
  }
}

interface SendOptions {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
  signal: AbortSignal;
  /** Headers carrying the credential, dropped when a redirect crosses origins. */
  authHeaders: string[];
}

/**
 * Follow redirects by hand.
 *
 * `redirect: 'follow'` would do this for us, but undici only strips
 * `authorization` when the hop crosses an origin. A custom-header credential,
 * which is how most API keys are configured, would follow the redirect to
 * whatever host the target named, and handing someone's API key to an
 * arbitrary server is not something a workflow should be able to do by
 * accident.
 */
async function send(options: SendOptions): Promise<Response> {
  let { url, method, body } = options;
  let headers = options.headers;

  for (let hop = 0; ; hop++) {
    const response = await fetch(url, { method, headers, body, signal: options.signal, redirect: 'manual' });

    const location = response.headers.get('location');
    if (!isRedirect(response.status) || !location) return response;

    // A redirect body is never read, and leaving it undrained holds the
    // connection open until the pool times it out.
    await response.body?.cancel().catch(() => {});

    if (hop >= MAX_REDIRECTS) {
      throw new NodeError('TooManyRedirects', `${url.host} redirected more than ${MAX_REDIRECTS} times.`, {
        url: url.toString(),
      });
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new NodeError('ConnectionError', `${url.host} redirected to an address that is not a URL.`, {
        location,
      });
    }

    if (next.origin !== url.origin) {
      headers = new Headers(headers);
      for (const name of options.authHeaders) headers.delete(name);
      // Cookies belong to the origin that set them, same as the credential.
      headers.delete('cookie');
    }

    // 303 always becomes a GET, and browsers have long done the same for 301
    // and 302 after a POST. Servers are written expecting that.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = new Headers(headers);
      headers.delete('content-type');
    }

    url = next;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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

  const text = await readLimitedText(response);
  if (!wantsJson) return text;

  try {
    return JSON.parse(text);
  } catch {
    // An endpoint that claims JSON and sends something else is common enough
    // that failing here would be unhelpful. Hand back the text.
    return text;
  }
}

/**
 * Read the body, refusing anything past the cap.
 *
 * Streaming rather than trusting `content-length`, which a server is free to
 * omit or lie about. Failing is deliberate: silently handing a truncated body
 * to the workflow would produce a subtly wrong run rather than an obvious one.
 */
async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) return '';

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let size = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new NodeError(
          'ResponseTooLarge',
          `The response is larger than ${Math.round(MAX_RESPONSE_BYTES / 1_000_000)}MB. Ask the endpoint for less, or page through it.`,
          { limitBytes: MAX_RESPONSE_BYTES },
        );
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return text + decoder.decode();
}

function truncate(value: unknown, max = 2000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
