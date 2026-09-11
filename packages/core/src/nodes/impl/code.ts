import { NodeError, type Item, type NodeExecute } from '../../types.js';

export const executeCode: NodeExecute = async (ctx) => {
    const [{ spawn }] = await Promise.all([import('node:child_process')]);

    const sandboxPath = await resolveSandboxPath();
    const source = ctx.getParam<string>('code') ?? '';
    const mode = ctx.getParam<string>('mode') ?? 'allItems';
    const timeoutMs = Number(ctx.getParam('timeoutMs') ?? 15000);

    if (source.trim() === '') {
      throw new NodeError('ConfigurationError', 'The Code node has no code in it.');
    }

    const request = JSON.stringify({
      code: source,
      mode,
      items: ctx.items,
      context: {
        $node: ctx.getParam('__nodeOutputs') ?? {},
        $now: new Date().toISOString(),
        $env: pickExposedEnv(),
      },
    });

    const child = spawn(
      process.execPath,
      [
        // Node's permission model: no filesystem, no child processes, no native
        // addons. The sandbox file itself is the single readable path.
        '--permission',
        `--allow-fs-read=${sandboxPath}`,
        '--no-warnings',
        sandboxPath,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      // Cap it: a runaway loop writing to stderr should not eat the worker's
      // memory on its way to the timeout.
      if (stderr.length < 64_000) stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stdin.end(request);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    });

    if (timedOut) {
      throw new NodeError('TimeoutError', `The code did not finish within ${timeoutMs}ms and was stopped.`, {
        timeoutMs,
      });
    }

    if (ctx.signal.aborted) {
      throw new NodeError('CancelledError', 'The execution was cancelled while the code was running.');
    }

    let parsed: SandboxResponse;
    try {
      parsed = JSON.parse(stdout) as SandboxResponse;
    } catch {
      // No parseable response means the child died before answering, which is
      // usually a crash or an out-of-memory kill rather than a script error.
      throw new NodeError(
        'SandboxError',
        `The code process exited with code ${exitCode} without returning a result.` +
          (stderr ? ` ${firstLine(stderr)}` : ''),
        { exitCode, stderr: stderr.slice(0, 2000) },
      );
    }

    if (!parsed.ok) {
      throw new NodeError(parsed.error.name || 'CodeError', parsed.error.message, {
        stack: parsed.error.stack,
      });
    }

    for (const entry of parsed.value.logs) {
      ctx.logger[entry.level === 'debug' ? 'debug' : entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : 'info'](
        entry.message,
      );
    }

    return [parsed.value.items];
  };



/**
 * Find the sandbox script on disk.
 *
 * The obvious `new URL('./code-sandbox.mjs', import.meta.url)` works when the
 * worker runs from source, but not when this module has been bundled into the
 * Next.js server for the single-container arrangement: there `import.meta.url`
 * points inside the build output, where no such sibling file exists. The
 * script has to be a real file because it is spawned as a separate process, so
 * bundling cannot help. Hence a search, with an env override for anyone whose
 * layout is neither of these.
 */
let cachedSandboxPath: string | null = null;

async function resolveSandboxPath(): Promise<string> {
  if (cachedSandboxPath) return cachedSandboxPath;

  const [{ existsSync }, { fileURLToPath }, path] = await Promise.all([
    import('node:fs'),
    import('node:url'),
    import('node:path'),
  ]);

  const candidates = [
    process.env.M8X_CODE_SANDBOX_PATH,
    safely(() => fileURLToPath(new URL('./code-sandbox.mjs', import.meta.url))),
    path.join(process.cwd(), 'packages/core/src/nodes/impl/code-sandbox.mjs'),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      cachedSandboxPath = candidate;
      return candidate;
    }
  }

  throw new NodeError(
    'SandboxError',
    'Could not find the Code node sandbox script. Set M8X_CODE_SANDBOX_PATH to its location.',
    { tried: candidates.filter(Boolean) },
  );
}

function safely(resolve: () => string): string | undefined {
  try {
    return resolve();
  } catch {
    return undefined;
  }
}

interface SandboxResponse {
  ok: boolean;
  value: { items: Item[]; logs: Array<{ level: string; message: string; at: string }> };
  error: { name: string; message: string; stack?: string };
}

/**
 * Only variables the operator opted into are visible to workflow code. The
 * process environment holds the database URL and the credential key, and none
 * of that belongs in a Code node.
 */
function pickExposedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('M8X_VAR_') && value !== undefined) {
      out[key.slice('M8X_VAR_'.length)] = value;
    }
  }
  return out;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}
