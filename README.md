# m8x

Self-hosted workflow automation. Folders, execution history, and real insight
into failures are all part of the thing, not part of a paid tier.

## What is here

- **A visual editor.** A node graph on a canvas, with a parameter panel
  generated from each node's schema.
- **Built-in nodes.** Manual, Webhook, Schedule and Telegram triggers; HTTP
  Request, Code, Set, Execute Workflow, Respond to Webhook, CSV, HTML and XML;
  seven Telegram actions; and the flow group — If, Filter, Switch, Merge, Split
  Out, Loop Over Items, Aggregate, Summarize, Sort, Limit, Remove Duplicates,
  Wait, No Operation and Stop and Error. The Code node is the escape hatch for
  everything else.
- **Loops and sub-workflows.** A back-edge into a Loop Over Items node is the
  one cycle the runner allows, and Execute Workflow runs another workflow and
  carries on with what it produced.
- **Telegram bots, shared properly.** A bot is polled once and its messages are
  handed to every workflow listening for them, so one bot can back five
  workflows with different command filters instead of one workflow monopolising
  it.
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
- **History that cleans up after itself.** Every node run stores what it saw,
  which is what makes the detail view worth opening and also what fills a disk.
  Successful runs and failed ones age out on separate clocks — a week and a
  month out of the box — and the worker deletes what is past them in bounded
  batches. Insights shows the policy next to how much history there actually is
  — see [docs/retention.md](docs/retention.md).
- **Pinned data, and results where you are building.** Running from the editor
  stays in the editor: outcomes are painted onto the canvas and the node you
  click shows the items that went in and came out. Freeze a node's output and
  it is replayed instead of run, so iterating on the seventh node stops
  re-sending the Telegram message the first one sends. A live run cannot reach
  a pin — see [docs/pinned-data.md](docs/pinned-data.md).

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

### Running against your own Postgres, without compose

Compose is a convenience, not a requirement. The images work on their own
against an existing database:

```bash
docker run -d --name m8x-web -p 3000:3000   -e DATABASE_URL="postgresql://user:pass@your-db:5432/m8x?schema=public"   -e M8X_ENCRYPTION_KEY="..."   -e M8X_PUBLIC_URL="https://m8x.example.com"   ghcr.io/rinukkusu/m8x-web
```

```bash
docker run -d --name m8x-worker   -e DATABASE_URL="postgresql://user:pass@your-db:5432/m8x?schema=public"   -e M8X_ENCRYPTION_KEY="..."   ghcr.io/rinukkusu/m8x-worker
```

The web image applies the schema on startup, so nothing has to run migrations
for you. Start it first, or expect the worker to log a failed scheduler tick
until the tables exist.

Workers never touch the schema, which is what makes them safe to scale: start
three of them to work through a backlog and none of them will run DDL, let
alone race another one doing the same. The web container is the one a
deployment always has exactly one of, so it owns the schema.

Set `M8X_AUTO_MIGRATE=0` on the web container if your deploy pipeline would
rather own that, and apply the schema yourself with:

```bash
docker run --rm -e DATABASE_URL="..." ghcr.io/rinukkusu/m8x-web   node /opt/prisma/node_modules/prisma/build/index.js db push   --schema packages/core/prisma/schema.prisma --skip-generate
```

### One container instead of two

The worker can run inside the web server rather than beside it. One container,
one thing to deploy:

```bash
docker run -d --name m8x -p 3000:3000   -e DATABASE_URL="postgresql://user:pass@your-db:5432/m8x?schema=public"   -e M8X_ENCRYPTION_KEY="..."   -e M8X_RUN_WORKER_IN_WEB=1   ghcr.io/rinukkusu/m8x-web
```

It is the same execution loop either way, started from Next's instrumentation
hook instead of from its own process, so the two arrangements cannot drift
apart. The container still applies the schema on boot, the same as any other
web container.

What you give up, in the order it will bother you:

- **Deploying kills in-flight runs.** Restarting to ship a UI change terminates
  any workflow mid-execution.
- **A runaway workflow takes the UI with it.** One process means one memory
  limit, so you lose the screen you would use to find out what happened.
- **You cannot scale the two separately.** Two web replicas means two workers.

For one team on one box that is usually a fair trade. For anything where a
failed run costs something, run the two containers.

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

### Loops

The runner orders the graph and walks it once, which is why a cycle used to be a
hard error. One cycle is allowed now: a back-edge into a **Loop Over Items**
node.

That node's *region* is everything reachable from its Loop branch that is not
also reachable from its Done branch. The subtraction is the whole design. A node
fed by both branches is where the loop rejoins the workflow, so it runs once,
afterwards. A leaf hanging off the Loop branch that never returns — "post a
message per batch" — is inside the region and runs every pass, which is what
putting it there means.

The region is collapsed onto its loop node before ordering, then run with a
nested pass. Each pass writes its own `NodeRun` rows, so the detail view shows
every one of them rather than only the last. Loops inside loops are refused by
name; the scheduler generalises to them, so that is a validation rule rather
than a rewrite.

### Sub-workflows

An Execute Workflow node runs a child in the parent's own process rather than
through the queue. Through the queue the parent would block on a row it cannot
observe finishing while still holding its worker slot, and once every slot is a
parent waiting on a child queued behind it, the pool deadlocks. Running inline
also means the parent's abort signal reaches the child for nothing.

Two guards stop a chain that would not end: the ancestor stack refuses a
workflow already running above this one, before any side effect fires, and a
depth budget bounds fan-out that never repeats a workflow.

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
| `M8X_AUTO_MIGRATE` | `1` in the web image, `0` in the worker; override to move who applies the schema |
| `M8X_RUN_WORKER_IN_WEB` | set to `1` to run the worker inside the web server |
| `M8X_CODE_SANDBOX_PATH` | override for the Code node's sandbox script; both images set it already |
| `M8X_TELEGRAM_API_BASE` | override for `https://api.telegram.org`, for a local Bot API server or an egress proxy |
| `M8X_MAX_LOOP_ITERATIONS` | passes a Loop Over Items node may make before the run fails, default 1000 |
| `M8X_MAX_SUBWORKFLOW_DEPTH` | how deep one workflow may call another, default 5 |

## Images

Pushes to `main` publish two images to the GitHub Container Registry:

```
ghcr.io/rinukkusu/m8x-web
ghcr.io/rinukkusu/m8x-worker
```

Both come from the same Dockerfile, which has a `web` and a `worker` target
over a shared base. Tags are `latest` on the default branch, the full commit
SHA on every push, and semver on `v*` tags. Pull requests build both images but
publish neither.

## Tests

```bash
npm test
```

The suite covers the runner: topological ordering, item fan-out through
branches, loop regions and what each pass may see, sub-workflow calls through a
stub, retry and backoff, expression evaluation and its sandbox limits, and
error fingerprinting. It also covers the pure half of the Telegram nodes, which
is the payload each one builds and the rules deciding which triggers an incoming
update belongs to. Those are the places where a subtle bug is expensive and a
test is cheap.

Nothing here talks to a network or a database, which is deliberate and is also
the gap: the poller's leasing is only exercised by running two workers.

## Known gaps

- **No loops inside loops.** One Loop Over Items node can close a cycle; a
  second one inside its region is refused by name. The scheduler generalises to
  nested regions, so this is a validation rule rather than a rewrite.
- **A Wait is capped at five minutes.** The run is held open for the whole wait.
  Longer than that needs suspend and resume state the Execution model does not
  have.
- **A retry from inside a loop restarts the whole run.** There is nowhere in the
  outer order to express "start at pass four".
- **A waiting sub-workflow holds its parent's worker slot.** It runs inline, so
  a deep chain pins one worker for the whole chain. Bounded by the nesting
  limit.
- **The Code node's network access is not restricted.** See above.
- **Cancelling only works before a run starts.** Stopping one mid-flight needs
  the worker to cooperate.
- **A retry from downstream of an If starts at the If.** `NodeRun` flattens
  output branches for display, so a partial retry cannot restore which branch an
  item came from.
- **Schedules have minute resolution.** The scheduler ticks once a minute and
  claims what is due.
- **A pin restores one output branch.** `NodeRun` flattens branches for display,
  so pinning an If keeps what it produced, not which branch each item left by.
  The same limitation as a retry from downstream of an If, and it should be
  fixed in one place.
- **Nothing inside a loop can be pinned.** A loop body runs once per pass and a
  pin would freeze every pass to the same items, so it is refused by name.
- **Pinned data cannot be typed in.** A pin is always something a run really
  produced. Hand-written fixtures are a different feature.

## License

MIT. See [LICENSE](LICENSE).
