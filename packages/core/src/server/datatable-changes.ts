/**
 * What a write to a datatable announces, and who hears it.
 *
 * The change trigger is fed from the write path rather than from a poller,
 * because nothing outside this application owns a cursor into these rows: there
 * is no position to lease and none to resume. That only works while every write
 * goes through `datatables.ts`, which is the rule most likely to be broken by
 * accident later.
 *
 * Publishing is kept behind this registry so `datatables.ts` never imports the
 * queue or the execution layer, and a process that only reads rows — the editor
 * rendering a grid — does not start a worker's worth of machinery to do it.
 */

export type DatatableEvent = 'insert' | 'update' | 'delete';

/** Who wrote. Null for the grid, which belongs to no workflow. */
export interface WriteSource {
  workflowId?: string;
  executionId?: string;
}

export interface RowChange {
  rowId: string;
  /** The stored row. Absent on delete. */
  row?: Record<string, unknown>;
  /** What it was before. Absent on insert. */
  previous?: Record<string, unknown>;
}

export interface DatatableChangeSet {
  datatableId: string;
  event: DatatableEvent;
  rows: RowChange[];
  source: WriteSource | null;
  /**
   * Set by the grid for bulk edits, so correcting two hundred rows by hand does
   * not start two hundred rows' worth of automation. Deliberately not reachable
   * from a node: a workflow silencing its own writes would make every datatable
   * trigger untrustworthy.
   */
  silent?: boolean;
}

export type DatatableChangeHandler = (change: DatatableChangeSet) => Promise<void> | void;

const handlers = new Set<DatatableChangeHandler>();

export function onDatatableChange(handler: DatatableChangeHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * Announce a committed write.
 *
 * Called after the transaction commits, never inside it: a write that rolls back
 * has to fire nothing, and publishing afterwards is the only way to be sure of
 * that. A handler that throws is logged and skipped, because a trigger failing
 * to start must not undo the write that caused it.
 */
export async function publishDatatableChange(change: DatatableChangeSet): Promise<void> {
  if (change.silent || change.rows.length === 0) return;

  for (const handler of handlers) {
    try {
      await handler(change);
    } catch (error) {
      console.error('[datatable] change handler failed', error);
    }
  }
}
