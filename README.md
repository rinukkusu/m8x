# m8x

Self-hosted workflow automation. Folders, execution history, and real insight
into failures are all part of the thing, not part of a paid tier.

## What is here

- **A visual editor.** A node graph on a canvas, with a parameter panel
  generated from each node's schema.
- **Ten built-in nodes.** Manual, Webhook and Schedule triggers; HTTP Request,
  Code and Set; If, Filter, Merge and Split Out. The Code node is the escape
  hatch for everything else.
- **Folders.** A real tree, with drag and drop, and a materialised path so
  filtering a subtree is one indexed query.
- **Execution history that is worth opening.** Every node run stores the exact
  items that went in and came out. The detail view is the workflow you built,
  with outcomes painted on and a panel showing the payload at any step.
- **Failure grouping.** Failures are fingerprinted by node type, error type and
  a normalised message, so four hundred failed runs collapse into the handful of
  distinct problems they actually are.
- **Retry from the failed node.** Upstream side effects already happened, so a
  partial retry resumes with the stored input rather than running them again.

## Getting started

Everything runs in Docker:

```bash
cp .env.example .env
```

Fill in the two secrets it asks for. A database password:

```bash
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
```

And the key that encrypts stored credentials:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put the password in both `POSTGRES_PASSWORD` and the `DATABASE_URL`, and the
key in `M8X_ENCRYPTION_KEY`. Compose refuses to start without the password
rather than falling back to a default, because a default password is what
actually ends up running.

Then bring the stack up:

```bash
docker compose up --build
```

Create the first account:

```bash
docker compose exec web npm run db:seed
```

The app is at http://localhost:3000. Sign in with the values of
`M8X_SEED_EMAIL` and `M8X_SEED_PASSWORD`.

### Running it locally instead

Postgres in Docker, the rest on the host:

```bash
docker compose up -d postgres
```

```bash
npm install && npm run db:push && npm run db:seed
```

Then run the two processes in separate terminals:

```bash
npm run dev:web
```

```bash
npm run dev:worker
```

Both are needed. The web app creates executions; the worker runs them.

## How it fits together

```
apps/web        Next.js: editor, executions, insights, webhook ingress
apps/worker     long-lived process that actually runs workflows
packages/core   node definitions, the runner, the database layer
```

The split between the app and the worker is the important one. A workflow can
run for minutes, retry with backoff, and hold state. A request handler is the
wrong shape for all three, so executions go through a `pg-boss` queue in the
same Postgres and a separate process picks them up.

Inside `packages/core` there is a second boundary worth knowing about.
`nodes/descriptors.ts` holds what every node looks like with none of its
behaviour, and it is the only part the editor imports. The behaviour lives in
`nodes/impl/`, reachable only through `@m8x/core/server`. That is what keeps the
Code node's child-process sandbox out of the browser bundle.

### The data model

Two decisions there are worth flagging, because both are painful to retrofit.

Every save snapshots the graph into a `WorkflowVersion`, and executions point at
the version they ran. Without that, editing a workflow would silently rewrite
the history of every run before it.

Failure detail is denormalised onto `Execution` alongside the full `NodeRun`
rows. The failures view filters and groups by those columns constantly, and
digging into node runs for every row would make the page slow exactly when it
becomes useful.

### Expressions

Node parameters take `{{ }}` templates: `{{ $json.order.total * 2 }}`. Available
are `$json`, `$items`, `$index`, `$node["Name"]`, `$now`, `$env` and
`$execution`.

This is a small interpreter, not `eval` and not `node:vm`. Expressions come from
workflow authors and run inside the worker, so giving them the real JS scope
would hand any workflow the database connection and the encryption key. A
template that is exactly one expression keeps the value's type, so
`{{ $json.count }}` yields a number rather than the string.

### The Code node

User scripts run in a separate process with Node's permission model on: no
filesystem, no spawning, no native addons.

One gap, stated plainly: Node's permission model does not cover the network, so
code in that node can still make outbound requests. For a single-team
deployment where the threat model is mistakes rather than attackers that is an
acceptable trade. It is not a claim of full isolation, and it is the thing to
fix before letting untrusted people write workflows.

## Configuration

| Variable | Purpose |
| --- | --- |
| `POSTGRES_PASSWORD` | Postgres password; compose will not start without it |
| `DATABASE_URL` | Postgres connection string, using that same password |
| `M8X_ENCRYPTION_KEY` | base64 of 32 bytes; encrypts stored credentials |
| `M8X_PUBLIC_URL` | used to build the webhook URLs shown in the editor |
| `M8X_FORCE_SECURE_COOKIES` | set to `1` when TLS is terminated by a proxy that does not send `x-forwarded-proto` |
| `M8X_WORKER_CONCURRENCY` | executions in flight per worker, default 5 |
| `M8X_VAR_*` | exposed to workflows as `$env.*`; nothing else is |

## Tests

```bash
npm test
```

The suite covers the runner: topological ordering, item fan-out through
branches, retry and backoff, expression evaluation and its sandbox limits, and
error fingerprinting. Those are the places where a subtle bug is expensive and
a test is cheap.

## Known gaps

- **No loops.** The runner requires a directed acyclic graph and rejects cycles
  with a named error. A batching node needs real cycle support in the scheduler.
- **The Code node's network access is not restricted.** See above.
- **Cancelling only works before a run starts.** Stopping one mid-flight needs
  the worker to cooperate.
- **A retry from downstream of an If starts at the If.** `NodeRun` flattens
  output branches for display, so a partial retry cannot restore which branch an
  item came from.
- **Schedules have minute resolution.** The scheduler ticks once a minute and
  claims what is due.

## License

MIT. See [LICENSE](LICENSE).
