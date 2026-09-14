import type { Item } from '../types.js';
import { asColumnList } from '../nodes/impl/datatable.js';
import { prisma } from './db.js';
import { createExecution } from './executions.js';
import { onDatatableChange, type DatatableChangeSet, type RowChange } from './datatable-changes.js';

/**
 * Turning a committed datatable write into executions.
 *
 * This is the whole of the datatable trigger. There is no poller and no cursor,
 * because nothing outside this application owns a position in these rows: the
 * write path knows what changed the moment it commits, and a poller would only
 * be a slower way of finding out the same thing.
 *
 * The price is that a row written straight into Postgres fires nothing. For a
 * tool where the app owns its database that is the right trade; if it stops
 * being true, an outbox table is the upgrade and it changes only this file and
 * `datatables.ts`.
 */

export interface DatatableTriggerConfig {
  datatableId?: string;
  events?: unknown;
  watchColumns?: unknown;
  includeOwnWrites?: boolean;
}

/** One item per changed row. The event rides beside the row, not inside it. */
export function itemFor(change: DatatableChangeSet, row: RowChange): Item {
  return {
    json: {
      event: change.event,
      datatableId: change.datatableId,
      rowId: row.rowId,
      ...(row.row ? { row: row.row } : {}),
      ...(row.previous ? { previous: row.previous } : {}),
    },
  };
}

/**
 * Whether one trigger wants one changed row.
 *
 * The column watch only means anything for an update: an insert or a delete
 * changes every column the row has, so filtering those by column would make a
 * trigger that never fires.
 */
export function rowMatches(config: DatatableTriggerConfig, change: DatatableChangeSet, row: RowChange): boolean {
  const watched = asColumnList(config.watchColumns);
  if (watched.length === 0 || change.event !== 'update') return true;

  const before = row.previous ?? {};
  const after = row.row ?? {};
  return watched.some((column) => JSON.stringify(before[column]) !== JSON.stringify(after[column]));
}

export function triggerWants(config: DatatableTriggerConfig, change: DatatableChangeSet): boolean {
  if (config.datatableId !== change.datatableId) return false;

  const events = asColumnList(config.events);
  // An empty list is a trigger nobody has configured yet, which listens for
  // everything rather than for nothing.
  if (events.length > 0 && !events.includes(change.event)) return false;

  return true;
}

/**
 * Start the workflows listening to a change.
 *
 * A workflow's own writes are skipped unless it asked for them: a datatable node
 * writing to the table its trigger watches would otherwise run until someone
 * switched the workflow off, and that is the mistake people actually make.
 */
export async function dispatchDatatableChange(change: DatatableChangeSet): Promise<void> {
  // Scoped in the query rather than in the loop: every write would otherwise
  // load every datatable trigger in the installation to discard most of them.
  const triggers = await prisma.trigger.findMany({
    where: {
      kind: 'datatable',
      enabled: true,
      config: { path: ['datatableId'], equals: change.datatableId },
    },
  });

  for (const trigger of triggers) {
    const config = (trigger.config ?? {}) as DatatableTriggerConfig;
    if (!triggerWants(config, change)) continue;
    if (change.source?.workflowId === trigger.workflowId && config.includeOwnWrites !== true) continue;

    const rows = change.rows.filter((row) => rowMatches(config, change, row));
    if (rows.length === 0) continue;

    // One change set is one execution carrying one item per row. The item model
    // is an array already, so a Loop Over Items node downstream gives per-row
    // handling to anyone who wants it without five hundred runs in the history.
    try {
      await createExecution({
        workflowId: trigger.workflowId,
        trigger: 'datatable',
        input: rows.map((row) => itemFor(change, row)),
        triggerNodeId: trigger.nodeId,
      });
    } catch (error) {
      // One workflow that cannot be queued must not stop the change reaching
      // the others, and must never fail the write that caused it.
      console.error(`[datatable] could not queue ${trigger.workflowId}`, error);
    }
  }
}

/**
 * Subscribe the dispatcher to the write path.
 *
 * Called by whichever process writes rows — the worker for a node, the web app
 * for the grid — because a change has to become executions wherever it happens.
 * Setting the one handler slot, so calling it twice is calling it once.
 */
export function startDatatableTriggers(): void {
  onDatatableChange(dispatchDatatableChange);
}
