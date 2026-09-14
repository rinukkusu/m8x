'use server';

import type { DatatableColumn } from '@m8x/core';
import {
  createDatatable,
  deleteDatatable,
  deleteRows,
  insertRows,
  startDatatableTriggers,
  updateDatatable,
  updateRows,
} from '@m8x/core/server';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth';

/**
 * The grid's half of the write path.
 *
 * Edits here go through the same functions a node uses, which is what makes a
 * datatable trigger testable: change a cell, watch the workflow run. The
 * dispatcher is started on import because this process writes rows too — a
 * change has to become executions wherever it is made, not only in the worker.
 */
startDatatableTriggers();

export interface DatatableActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function failed(error: unknown): DatatableActionResult {
  return { ok: false, error: error instanceof Error ? error.message : 'That could not be saved.' };
}

function revalidate(id?: string): void {
  revalidatePath('/datatables');
  if (id) revalidatePath(`/datatables/${id}`);
  // The editor offers datatables and their columns on a node, so it has to see
  // a new table without passing through this section first.
  revalidatePath('/workflows/[id]', 'page');
}

export async function createDatatableAction(input: {
  name: string;
  description?: string;
}): Promise<DatatableActionResult> {
  await requireUser();
  if (input.name.trim() === '') return { ok: false, error: 'A datatable needs a name.' };

  try {
    const table = await createDatatable(input);
    revalidate(table.id);
    return { ok: true, id: table.id };
  } catch (error) {
    return failed(error);
  }
}

export async function updateDatatableAction(
  id: string,
  input: { name?: string; description?: string | null; columns?: DatatableColumn[] },
): Promise<DatatableActionResult> {
  await requireUser();

  try {
    await updateDatatable(id, input);
    revalidate(id);
    return { ok: true, id };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Delete the table and everything in it.
 *
 * Allowed even while workflows point at it, the way a credential is: the page
 * lists what it will break first, and a node that outlives its table fails with
 * an error naming the id. Refusing instead would mean editing every graph
 * before you are allowed to clean anything up.
 */
export async function deleteDatatableAction(id: string): Promise<DatatableActionResult> {
  await requireUser();

  try {
    await deleteDatatable(id);
    revalidate(id);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function insertRowAction(
  datatableId: string,
  data: Record<string, unknown>,
  silent = false,
): Promise<DatatableActionResult> {
  await requireUser();

  try {
    const [row] = await insertRows({ datatableId, rows: [data], silent });
    revalidate(datatableId);
    return { ok: true, id: row?.id };
  } catch (error) {
    return failed(error);
  }
}

export async function updateRowAction(
  datatableId: string,
  rowId: string,
  data: Record<string, unknown>,
  silent = false,
): Promise<DatatableActionResult> {
  await requireUser();

  try {
    await updateRows({ datatableId, rowIds: [rowId], set: data, silent });
    revalidate(datatableId);
    return { ok: true, id: rowId };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteRowAction(
  datatableId: string,
  rowId: string,
  silent = false,
): Promise<DatatableActionResult> {
  await requireUser();

  try {
    await deleteRows({ datatableId, rowIds: [rowId], silent });
    revalidate(datatableId);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
