'use server';

import { deleteCredential, saveCredential } from '@m8x/core/server';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth';

export interface CredentialActionResult {
  ok: boolean;
  error?: string;
  /** Set on a successful save, so a caller can select what it just created. */
  id?: string;
}

export async function saveCredentialAction(input: {
  id?: string;
  name: string;
  type: string;
  data: Record<string, string>;
}): Promise<CredentialActionResult> {
  await requireUser();

  if (input.name.trim() === '') return { ok: false, error: 'A credential needs a name.' };

  try {
    const id = await saveCredential(input);
    revalidatePath('/credentials');
    // The editor picks credentials on a node, so its page has to see a new one
    // too — it is reachable without ever passing through /credentials.
    revalidatePath('/workflows/[id]', 'page');
    return { ok: true, id };
  } catch (error) {
    // The most likely failure by far is the unique name constraint, but an
    // unset encryption key surfaces here too and is worth showing verbatim.
    return { ok: false, error: error instanceof Error ? error.message : 'That could not be saved.' };
  }
}

export async function deleteCredentialAction(id: string): Promise<CredentialActionResult> {
  await requireUser();

  await deleteCredential(id);
  revalidatePath('/credentials');
  revalidatePath('/workflows/[id]', 'page');
  return { ok: true };
}
