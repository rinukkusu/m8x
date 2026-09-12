import { createExecution, prisma } from '@m8x/core/server';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Webhook ingress.
 *
 * The handler's only job is to turn a request into an execution row and hand it
 * to the queue. It deliberately does not run the workflow: a request handler
 * that waits on a five-minute workflow is a request handler that times out.
 */

export const dynamic = 'force-dynamic';

/** How long the "wait for the result" mode will hold a request open. */
const WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const MAX_BODY_BYTES = 2_000_000;

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const webhookPath = path.join('/');

  const trigger = await prisma.trigger.findUnique({
    where: { webhookPath },
    include: { workflow: { select: { id: true, active: true } } },
  });

  if (!trigger || !trigger.enabled) {
    return NextResponse.json({ error: 'No webhook is registered at this path.' }, { status: 404 });
  }

  if (!trigger.workflow.active) {
    // A deliberately distinct status: the path exists, the workflow is off.
    // Debugging "why did nothing happen" is much faster with 409 than 404.
    return NextResponse.json(
      { error: 'The workflow for this webhook is not active.' },
      { status: 409 },
    );
  }

  const config = (trigger.config ?? {}) as { method?: string; respond?: string };
  const allowed = config.method ?? 'POST';

  if (allowed !== 'ANY' && request.method !== allowed) {
    return NextResponse.json(
      { error: `This webhook accepts ${allowed}, not ${request.method}.` },
      { status: 405, headers: { allow: allowed } },
    );
  }

  const body = await readBody(request);
  if (body.tooLarge) {
    return NextResponse.json({ error: 'The request body is too large.' }, { status: 413 });
  }

  const url = new URL(request.url);

  const { executionId } = await createExecution({
    workflowId: trigger.workflowId,
    trigger: 'webhook',
    input: [
      {
        json: {
          method: request.method,
          path: webhookPath,
          headers: Object.fromEntries(request.headers.entries()),
          query: Object.fromEntries(url.searchParams.entries()),
          body: body.value,
          receivedAt: new Date().toISOString(),
        },
      },
    ],
  });

  if (config.respond !== 'whenFinished' && config.respond !== 'usingRespondNode') {
    return NextResponse.json({ executionId, status: 'queued' }, { status: 202 });
  }

  const finished = await waitForExecution(executionId);

  if (!finished) {
    return NextResponse.json(
      { executionId, status: 'running', error: 'The workflow is still running.' },
      { status: 504 },
    );
  }

  if (config.respond === 'usingRespondNode' && finished.status !== 'failed') {
    const composed = await composedResponse(executionId);
    if (composed) return composed;
  }

  return NextResponse.json(
    {
      executionId,
      status: finished.status,
      ...(finished.status === 'failed'
        ? { error: finished.errorMessage, node: finished.errorNodeName }
        : {}),
    },
    { status: finished.status === 'failed' ? 500 : 200 },
  );
}

/**
 * The response a Respond to Webhook node wrote, if the run reached one.
 *
 * Read off the stored NodeRun rather than passed back from the runner, because
 * the runner does not know a request is open and may not even be in this
 * process. Returns null when there is nothing usable, and the caller falls back
 * to the plain envelope: a silently truncated body would be worse than an
 * honest "the workflow ran" reply.
 */
async function composedResponse(executionId: string): Promise<NextResponse | null> {
  const run = await prisma.nodeRun.findFirst({
    where: { executionId, nodeType: 'action.respondToWebhook', status: 'success' },
    orderBy: { sequence: 'desc' },
    select: { output: true, outputTruncated: true },
  });

  if (!run || run.outputTruncated) return null;

  const first = Array.isArray(run.output) ? (run.output[0] as { json?: ComposedResponse } | undefined) : undefined;
  const response = first?.json;
  if (!response) return null;

  const headers: Record<string, string> = {
    ...(response.headers ?? {}),
    'content-type': response.contentType ?? 'application/json',
  };

  const status = response.status ?? 200;
  const body = response.body;

  if (body === null || body === undefined) return new NextResponse(null, { status, headers });

  // An object body with a JSON content type is the common case and should not
  // arrive as "[object Object]".
  return new NextResponse(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

interface ComposedResponse {
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Poll the execution row until it settles.
 *
 * Polling rather than a Postgres LISTEN channel because the web app and the
 * worker are separate processes and this is the one place the two need to meet.
 * A quarter-second poll for at most thirty seconds is cheap.
 */
async function waitForExecution(executionId: string) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const execution = await prisma.execution.findUnique({
      where: { id: executionId },
      select: { status: true, errorMessage: true, errorNodeName: true },
    });

    if (execution && execution.status !== 'queued' && execution.status !== 'running') {
      return execution;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return null;
}

async function readBody(request: NextRequest): Promise<{ value: unknown; tooLarge: boolean }> {
  if (request.method === 'GET' || request.method === 'HEAD') return { value: null, tooLarge: false };

  const contentType = request.headers.get('content-type') ?? '';

  // Refuse on the declared length before reading anything. Checking afterwards
  // would mean the whole body is already in memory by the time we object,
  // which is most of what the limit is for.
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { value: null, tooLarge: true };

  const raw = await readLimitedText(request, MAX_BODY_BYTES);
  if (raw === null) return { value: null, tooLarge: true };
  if (raw === '') return { value: null, tooLarge: false };

  if (contentType.includes('json')) {
    try {
      return { value: JSON.parse(raw), tooLarge: false };
    } catch {
      // A sender that claims JSON and sends something else should still reach
      // the workflow, which can decide what to do about it.
      return { value: raw, tooLarge: false };
    }
  }

  if (contentType.includes('x-www-form-urlencoded')) {
    return { value: Object.fromEntries(new URLSearchParams(raw).entries()), tooLarge: false };
  }

  return { value: raw, tooLarge: false };
}

/**
 * Read the body, stopping at the cap.
 *
 * Returns null when the sender goes past it, which covers a chunked request
 * that declared no length at all, and the sender that declared a small one and
 * then kept going.
 */
async function readLimitedText(request: NextRequest, maxBytes: number): Promise<string | null> {
  if (!request.body) return '';

  const decoder = new TextDecoder();
  const reader = request.body.getReader();
  let size = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > maxBytes) return null;

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return text + decoder.decode();
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
