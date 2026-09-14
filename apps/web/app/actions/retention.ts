'use server';

import { setRetentionPolicy, type PolicyResult } from '@m8x/core/server';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth';

/**
 * The retention policy's write path.
 *
 * The validation lives in core beside the job that enforces the policy, so the
 * form and the worker cannot disagree about what a valid number of days is.
 * This is the thin half: who is asking, and what to re-render afterwards.
 */
export async function setRetentionPolicyAction(input: {
  successDays: number | null;
  failureDays: number | null;
}): Promise<PolicyResult> {
  await requireUser();

  const result = await setRetentionPolicy(input);
  if (result.ok) revalidatePath('/insights');

  return result;
}
