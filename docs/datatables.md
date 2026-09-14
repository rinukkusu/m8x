# Datatables

A datatable is a table of rows a workflow can read and write. It exists because
workflows need somewhere to keep state between runs: a list of customers already
emailed, a queue of things to process, the last price seen for a product. Before
this, the only honest answer to "where do I put that" was an HTTP Request node
pointing at somebody else's database.

This document is the design the implementation follows, and the reasoning behind
the parts that could have gone another way.

## Storage

Two tables. One holds the metadata, one holds the rows.

```prisma
model Datatable {
  id          String   @id @default(cuid())
  name        String   @unique
  description String?
  // [{ key, name, type, required?, unique?, default? }]
  columns     Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  rows        DatatableRow[]
}

model DatatableRow {
  id          String    @id @default(cuid())
  datatableId String
  datatable   Datatable @relation(fields: [datatableId], references: [id], onDelete: Cascade)
  // Exactly an Item.json: what a node reads is what a node wrote.
  data        Json
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@index([datatableId, createdAt(sort: Desc)])
  @@index([data(ops: JsonbPathOps)], type: Gin)
}
```

One row per record, with the record in a `Json` column. Not one row per field.

The k/v shape is the obvious first idea and it is the wrong one here. An
eight-column table becomes eight rows per record, so reading the grid is a pivot
over everything; filtering on two fields is a self-join or a `having count(*) =
2` trick; and every value is text, so `total > 100` is a cast per row that no
index can help. What that shape buys — adding a column without a migration —
JSONB already gives us, because the column list is metadata and the rows are
schemaless underneath it.

It also fits what is already here. `Workflow.graph`, `Trigger.config` and
`NodeRun.input` are all `Json`, and `DatatableRow.data` *is* an `Item.json`, so
insert and get need no mapping layer between the item model and storage.

The third option, a real Postgres table per datatable, is out: DDL at runtime,
migrations nobody owns, column names from user input reaching the planner, and
none of it visible to Prisma.

### Columns are metadata, not layout

Adding, removing or renaming a column writes one `Datatable` row and touches no
`DatatableRow` at all. Rows that predate a column simply lack the key, and reads
fill in the column default, or null. Removing a column leaves the key in the
rows that have it; it stops being displayed and stops being offered as a filter
field, which is the whole of what removal means.

A column declares `type` (`string`, `number`, `boolean`, `datetime`, `json`),
and optionally `required`, `unique` and `default`.

### What the declaration is worth at write time

Declared columns are coerced to their type — `"42"` into a number column is
stored as `42`. A required column that is missing, or a value that cannot be
coerced, fails the node with a `NodeError`. Keys that are not declared columns
are stored as they arrive.

Coercing is what keeps typed filters honest: `gt` on a number column has to be
comparing numbers, or `"9" > "42"` is true. Keeping undeclared keys is what
stops a workflow dying the day an upstream API adds a field. Rejecting unknown
keys would be defensible, but it means editing the column list every time a
payload grows, and that cost lands on the person least able to predict it.

One `coerceRow(columns, data)` function does this, and everything that writes
goes through it: the nodes, the grid, any import.

### Limits

- **64 kB per row**, measured on the serialised JSON. Over that, the write
  fails. This mirrors the `NodeRun` payload cap; a row nobody can display in a
  execution view is not useful, and rows are read back into memory in bulk.
- **`get` returns 50 rows by default, 1000 at most.** A larger limit is clamped
  rather than refused, and the node says so on its output.
- **Rows per table are unbounded**, with a warning in the UI past about 100k
  rows. A hard ceiling would turn one legitimate large table into a support
  question; the row cap and the read cap are what actually protect the process.
- **One node call changes at most 1000 rows**, the same ceiling as a read, and
  for the same reason: a change set becomes one execution carrying one item per
  row, so an unbounded update would build an execution input nobody can open.
  Over that, the node fails and names the count. Truncating the change set
  instead would start a workflow that quietly missed half its work.

## Writing

Every write goes through one function in `packages/core/src/server/datatables.ts`.
There is no second door — not the grid, not a node, not a future import. That is
what makes the change trigger possible at all, and it is the rule most likely to
be broken by accident later.

```ts
interface WriteSource {
  /** The workflow whose node wrote this, when a node did. */
  workflowId?: string;
  executionId?: string;
}

interface ChangeSet {
  datatableId: string;
  event: 'insert' | 'update' | 'delete';
  rows: Array<{ rowId: string; row?: Json; previous?: Json }>;
  source: WriteSource | null;
  /** Set by the grid for bulk edits. Suppresses triggers. */
  silent?: boolean;
}
```

The change set is emitted **after the transaction commits**. A write that rolls
back has to fire nothing, and the only way to be sure of that is to publish
afterwards.

### Uniqueness and upsert

`upsert` names its own match columns (`matchOn`) on the node and matches on
equality. Before matching it takes a `pg_advisory_xact_lock` on
`hash(datatableId, matchOn, values)`, so two concurrent runs of the same node
serialise instead of both inserting.

This is deliberately weaker than it looks, and the node description says so: two
different nodes keying the same table on different columns can still each insert
what the other would have matched. A column declared `unique` is checked on
insert as a backstop, but the primary defence is that the match key is a choice
the workflow author makes once and does not vary.

Per-table unique indexes would be stronger. They would also mean generating
expression indexes at runtime, which is the DDL problem again.

## Nodes

Five actions, one per operation, following the Telegram set rather than a single
node with an `operation` select:

| Type | What it does |
| --- | --- |
| `datatable.insert` | One row per input item. Returns the stored rows, including their ids. |
| `datatable.get` | Filter, sort, limit. One item per row; no match returns nothing. |
| `datatable.update` | Filter, then set fields. All matches by default. |
| `datatable.delete` | Filter, then remove. Returns what it deleted. |
| `datatable.upsert` | Match on `matchOn` columns; update the match or insert. |

Each references its table by id, the way a credential is referenced: the
dropdown shows the name, the graph stores the cuid, and renaming a table breaks
nothing.

Delete is a hard delete. The rows are gone, but the node returns them and the
change set carries them as `previous`, so a workflow can still react to what was
removed. A soft delete would put `deletedAt is null` into every read, grow the
table forever, and force a decision about whether a deleted row still blocks an
upsert.

### The filter block

`get`, `update` and `delete` ask the same question, so they share one exported
parameter block in `descriptors/shared.ts`, the way `conditionParams` is shared
by If, Filter and Switch. Rows of `{ field, operator, value }` reusing
`COMPARISON_OPERATORS`, plus a combinator (all / any).

`field` is a dropdown of the selected table's columns, and falls back to free
text so an expression still works.

### Dropdowns the descriptor cannot fill

The table list and the column list are only known at edit time. The inspector
special-cases them, the way it already special-cases the credential picker: a
marker on the parameter, one route that resolves it, and for columns a
dependency on the `datatableId` parameter alongside it.

A general `dynamicOptions` / `dependsOn` addition to `ParamSchema` would be the
cleaner answer, and it is the right refactor the moment a fourth thing needs
server-side options. Today three special cases — credential, table, columns —
are cheaper than a mechanism.

The filter rows need their own widget for the same reason: `keyValue` is two
columns and this is three.

## The change trigger

`trigger.datatable` fires when a table changes. It is fed from the write path,
not from a poller: there is no external system owning a cursor, so there is
nothing to lease and nothing to resume. `TriggerKind`, `TriggerSource` and the
`TRIGGER_KINDS` map in `server/triggers.ts` each gain one entry, and the
reconciler needs nothing else.

Config: the table, which events to listen for (insert, update, delete — any
combination), and optionally only when one of a named set of columns changed.

**One change set becomes one execution, with one item per changed row.** A
workflow inserting 500 rows produces one run holding 500 items, not 500 runs.
The item model is an array already; a Loop Over Items node downstream gets
per-row handling for anyone who wants it. A checkbox switches to one execution
per row where isolation genuinely matters.

Each item is:

```json
{ "event": "insert", "rowId": "clx…", "row": { }, "previous": { } }
```

`previous` appears on update and delete. Putting the event beside the row rather
than spreading the row across the top level means one workflow can watch all
three events and branch on `$json.event`.

### Not eating its own tail

A workflow whose datatable node writes to the table its own trigger watches
would otherwise run until someone deactivates it. The change set carries the
source workflow, and a trigger ignores changes from its own workflow. A checkbox
("also fire on writes from this workflow") turns that off for a deliberate
cascade.

That is one comparison, and it covers the mistake people actually make. A
chain-depth counter would allow self-feeding tables, which nobody has asked for.

### What does not fire it

A row written directly in psql. The application is the only writer the trigger
knows about, which is the price of not having an outbox table and a poller.
For a self-hosted tool where the app owns the database, that is the right trade;
if it stops being true, an outbox is the upgrade path and it changes only
`datatables.ts`.

## The UI

`/datatables`, alongside `/credentials`: the list of tables, a column editor, and
a paged grid with inline editing.

The grid is not optional. A table nobody can look at or correct by hand is a
worse Code node — the reason to have this at all is that you can see the state
your workflows are keeping, and fix it when it is wrong.

Grid edits go through the same write function, so they fire triggers exactly
like a node's writes do. That is what makes a datatable trigger testable: change
a cell, watch the workflow run. Bulk work gets a "don't trigger workflows"
toggle, which sets `silent` on the write — reachable only from the UI, because a
node quietly suppressing its own events would make the trigger untrustworthy.

Deleting a table warns first, listing the workflows that reference it, and then
allows it. Blocking the delete until every graph is edited is the stricter
choice, but it matches neither how credentials behave here nor what someone
clearing up actually wants. Nodes pointing at a table that is gone fail at run
time with `datatable_not_found` naming the id.

## Out of scope, on purpose

- **No external API.** Rows are reachable from nodes and from the grid. Anything
  else builds a workflow — Webhook trigger, `datatable.get`, Respond to Webhook —
  and gets auth, filtering and execution history for free instead of a second
  permission model.
- **No folders.** `Folder` relates to workflows only. Datatables stay flat until
  a flat list is actually painful.
- **No transactions across nodes.** Each node call commits on its own. The node
  descriptions say so rather than letting anyone assume otherwise.
