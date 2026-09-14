# Pinned data and in-editor results

Building a workflow means running it, looking at what came out, changing one
parameter and running it again. Until now that loop went through three screens:
press Run in the editor, get sent to the execution detail view, read the
payload, navigate back. Worse, every pass re-fired the trigger and everything
under it, so iterating on the seventh node meant sending another Telegram
message or POSTing the webhook again — and every side effect upstream happened
again with it.

This document is the design the implementation follows, and the reasoning behind
the parts that could have gone another way.

Two features, which only make sense together:

- **Results in the editor.** The run's outcomes are painted onto the canvas you
  are editing, and the node you click shows the exact items that went in and
  came out. No navigation.
- **Pinned data.** A node's output can be frozen. A pinned node does not
  execute: it hands its stored items straight to everything downstream. Capture
  the webhook payload once, then iterate on the rest of the workflow without
  touching the outside world.

## Where pinned data lives

In its own table, keyed by workflow and node, and not in the graph.

```prisma
model PinnedData {
  id         String   @id @default(cuid())
  workflowId String
  workflow   Workflow @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  nodeId     String
  // Exactly the items the node produced, truncated past the same cap NodeRun uses.
  items      Json
  truncated  Boolean  @default(false)
  // The run it was captured from, for "pinned from a run three days ago".
  sourceExecutionId String?
  createdAt  DateTime @default(now())

  @@unique([workflowId, nodeId])
}
```

Putting it on `GraphNode` instead is the obvious first idea and it is the wrong
one, for three reasons that all point the same way.

The graph is snapshotted into a `WorkflowVersion` on every save, and executions
point at that snapshot. Pinned payloads are large and change constantly while
you work, so every pin would mint a version and every version would carry a copy
of the payload. History would grow with editing rather than with running.

The graph is also what will be exported, copied between instances and eventually
diffed. A pinned payload is none of those things: it is scratch data belonging
to one person editing one workflow on one instance, and it has no business
travelling.

Most importantly, it keeps a live run structurally incapable of using pinned
data. The worker only loads pins for a run that explicitly asked for them, and
nothing but the editor asks. If pins lived in the graph, the runner would need a
flag meaning "ignore the pins", and the failure mode of forgetting that flag is
an activated workflow quietly serving three-day-old fake data to a real
customer. A separate table makes that mistake unavailable rather than merely
discouraged.

The payload is capped the same way `NodeRun` payloads are, by the same code, and
carries the same `truncated` flag. A pin that only holds the first fifty items
is still useful for shaping a downstream node, but the UI has to say so — a
truncated pin silently pretending to be the whole payload is the one way this
feature could produce a workflow that works while you build it and breaks when
you activate it.

## How a pinned node runs

The runner gains one field:

```ts
/** Node outputs supplied by the editor. A node listed here does not execute. */
pinnedOutputs?: Record<string, Item[][]>;
```

A node found in it never reaches its definition's `execute`. It emits a single
finish event carrying the pinned items as its output, and everything downstream
gathers input from those items exactly as if the node had produced them.

This is deliberately not `restoredOutputs`. That field answers "everything before
the retry point already ran, do not run it again", and it is paired with
`resumeFromNodeId`, which skips a prefix of the topological order. Pins are not a
prefix — a pin can sit anywhere in the graph, including in the middle, with live
nodes on both sides of it. Reusing one field for both questions would mean the
runner could not tell "this was restored from an earlier run" from "the author
froze this", and those two want different things on screen.

A pinned node is checked before every other rule in `step`, including the
disabled check and the trigger check. A pin means "these are the items", and it
should mean that regardless of what the node is. In particular it is how a
trigger gets its payload: pinning a webhook trigger's output is the whole point
of the feature.

Two rules that are not obvious:

**A pin does not suppress a skip.** A pinned node on a branch that the upstream
`If` did not take still skips. Its pinned items describe what it produces when it
runs, not whether it is reached, and having a pin resurrect a dead branch would
make the canvas lie about control flow.

**Pins inside a loop region are refused**, rather than silently applied. A loop
body runs once per pass, and a pin would freeze every pass to the same items,
which is never what anyone means. Refusing by name at validation time is honest;
applying it would produce a run that looks fine and is wrong.

## A fourth NodeRun status

```prisma
enum NodeRunStatus {
  running
  success
  failed
  skipped
  pinned
}
```

A pinned node could be recorded as `success` and it would very nearly work. It
is worth its own status anyway, because the execution detail view is the screen
this project exists for, and "this node produced these items" and "this node did
not run, these items are what you froze earlier" are different facts. Collapsing
them would mean opening a run from last Tuesday and being unable to tell which
parts of it actually happened.

It also gives the failures page something true to say. A run that succeeded
entirely on pinned data is not evidence that the workflow works.

## Carrying pins into a run

`Execution.input` already carries more than items — the trigger node id and the
retry resume point ride along in it, with `execution-input.ts` owning the shape
so the writing and reading sides cannot drift. One more field joins them:

```ts
/** Load this workflow's pinned data and let it stand in for those nodes. */
usePinnedData?: boolean;
```

A boolean rather than the pins themselves. The payloads would bloat a column
that is read back on every retry, and worse, a copy taken at queue time would go
stale: re-running a five-minute-old execution should use the pins as they are
now, not as they were. The worker loads them from the table at run time, filtered
to nodes that still exist in the snapshot it is running.

Only `runWorkflowAction` sets the flag, and only when called from the editor.
Every trigger-driven path leaves it unset, which is the structural guarantee
described above.

## Run from here

"Run from this node" is `resumeFromNodeId` — which already exists, built for
retry-from-failed-node — pointed at the editor instead of at history. Everything
before the named node is skipped, and its input is gathered from pinned outputs
upstream.

It is offered only when every node feeding the selected one is pinned. Without
that the node gathers input from nodes that were skipped and never produced
anything, and the run does nothing while appearing to work. The editor greys the
action and says which upstream node needs a pin, rather than letting you discover
it from an empty result.

Inside a loop region it is refused, for the same reason retry-from-node is: the
outer order steps over a region as one unit and there is nowhere to express
"start at pass four".

## What the editor shows

Running no longer navigates. The editor keeps the execution id, polls it while it
is in flight — the same three-second refresh the detail view uses, for the same
reason: a websocket is not worth the machinery for a page nobody leaves open for
hours — and paints each node's outcome onto the canvas as the rows land.

The inspector gains a **Results** tab beside Settings and On failure, holding
what the execution detail view's panel holds: status, duration, the error, the
logs, and the input and output items. The two views render it with the same
component, for the same reason the canvas node is shared between them — the
screen you debug on should be the screen you built on, not a second rendering of
it.

Pinning is a button on that panel, on the output of a run that actually
happened. That is the only way to create a pin, and it is deliberate: pinned data
is always something the workflow really produced, never something typed by hand.
Hand-authored fixtures are a reasonable thing to want and a different feature,
and starting with "keep what came out" avoids inventing an editor for item JSON
before knowing whether anyone needs one.

A pinned node is unmistakable on the canvas: a pin marker in its header and a
distinct border, not a subtle tint. The failure mode this is guarding against is
somebody activating a workflow while a trigger is pinned, deploying what they
think they tested. The runner already refuses to use the pin there, so the
consequence is confusion rather than damage — but the canvas should not be the
reason for the confusion. Activating a workflow that has pins warns about it by
name.

## What is not here

**Editing pinned data by hand.** As above: a pin is something a run produced.

**Pinning one branch of a multi-output node.** The stored shape is
`Item[][]`, so the model allows it, but the UI pins all branches at once because
`NodeRun` flattens branches for display and there is nowhere to click the second
one. It is the same limitation that makes a retry from downstream of an `If`
start at the `If`, and it should be fixed in one place when it is fixed.

**Expiry.** A pin lives until it is removed or its node is deleted. Stale pins
are a real hazard, but the honest fix is showing how old one is, which the
`createdAt` and `sourceExecutionId` above are for, rather than deleting data
somebody is in the middle of using.
