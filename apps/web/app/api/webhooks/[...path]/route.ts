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

  if (config.respond !== 'whenFinished') {
    return NextResponse.json({ executionId, status: 'queued' }, { status: 202 });
  }

  const finished = await waitForExecution(executionId);

  if (!finished) {
    return NextResponse.json(
      { executionId, status: 'running', error: 'The workflow is still running.' },
      { status: 504 },
    );
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
  const raw = await request.text();

  if (raw.length > MAX_BODY_BYTES) return { value: null, tooLarge: true };
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

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
