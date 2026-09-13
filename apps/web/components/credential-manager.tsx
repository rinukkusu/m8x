'use client';

import type { CredentialType } from '@m8x/core/server';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { deleteCredentialAction, saveCredentialAction } from '@/app/actions/credentials';
import { CredentialForm } from './credential-form';
import { Button, EmptyState, formatRelative } from './ui';

interface CredentialRow {
  id: string;
  name: string;
  type: string;
  updatedAt: string;
}

export function CredentialManager({
  types,
  credentials,
}: {
  types: CredentialType[];
  credentials: CredentialRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ id?: string; type: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="max-w-2xl space-y-4">
      {error ? (
        <p className="rounded-md border border-bad/25 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>
      ) : null}

      {credentials.length === 0 && !editing ? (
        <EmptyState
          title="No credentials yet"
          description="Store an API token here once, then pick it in an HTTP Request node instead of pasting the secret into the workflow."
          action={
            <Button variant="primary" size="sm" onClick={() => setEditing({ type: types[0]!.type })}>
              <Plus className="size-3.5" />
              Add credential
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex justify-end">
            <Button size="sm" variant="primary" onClick={() => setEditing({ type: types[0]!.type })}>
              <Plus className="size-3.5" />
              Add credential
            </Button>
          </div>

          <ul className="space-y-1.5">
            {credentials.map((credential) => (
              <li
                key={credential.id}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface-1 px-4 py-3"
              >
                <KeyRound className="size-4 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{credential.name}</span>
                  <span className="block text-xs text-ink-faint">
                    {types.find((type) => type.type === credential.type)?.displayName ?? credential.type} · updated{' '}
                    {formatRelative(credential.updatedAt)}
                  </span>
                </span>

                <Button
                  size="sm"
                  onClick={() => setEditing({ id: credential.id, type: credential.type })}
                  disabled={pending}
                >
                  Replace
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending}
                  onClick={() => {
                    if (!window.confirm(`Delete "${credential.name}"? Nodes using it will start failing.`)) return;
                    startTransition(async () => {
                      await deleteCredentialAction(credential.id);
                      router.refresh();
                    });
                  }}
                  aria-label={`Delete ${credential.name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}

      {editing ? (
        <CredentialForm
          types={types}
          initial={editing}
          existingName={credentials.find((credential) => credential.id === editing.id)?.name}
          pending={pending}
          onCancel={() => setEditing(null)}
          onSave={(input) => {
            setError(null);
            startTransition(async () => {
              const result = await saveCredentialAction(input);
              if (!result.ok) {
                setError(result.error ?? 'That could not be saved.');
                return;
              }
              setEditing(null);
              router.refresh();
            });
          }}
        />
      ) : null}
    </div>
  );
}
