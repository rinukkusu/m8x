'use client';

import type { CredentialType } from '@m8x/core/server';
import { Pencil, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { saveCredentialAction } from '@/app/actions/credentials';
import { CredentialForm, type CredentialFormValue } from '../credential-form';
import { Button, Field, Select } from '../ui';

export interface CredentialOption {
  id: string;
  name: string;
  type: string;
}

/**
 * The credential input on a node.
 *
 * Sending someone to the Credentials page to paste a token, then back to the
 * canvas to pick it, loses whatever they were in the middle of. The two icons
 * here open the same form the Credentials page uses, with the type already
 * fixed to what this input accepts, and select the result when it saves.
 */
export function CredentialPicker({
  label,
  hint,
  credentialType,
  value,
  credentials,
  credentialTypes,
  onChange,
}: {
  label: string;
  hint?: string;
  credentialType: string;
  value: string;
  credentials: CredentialOption[];
  credentialTypes: CredentialType[];
  onChange: (value: string | undefined) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * A credential created here is selected immediately, but the refreshed list
   * it belongs to only arrives on the next server render. Holding on to it for
   * that gap keeps the field from flashing back to "None".
   */
  const [justSaved, setJustSaved] = useState<CredentialOption | null>(null);

  const definition = credentialTypes.find((entry) => entry.type === credentialType);

  const matching = credentials.filter((credential) => credential.type === credentialType);
  const options =
    justSaved && !matching.some((credential) => credential.id === justSaved.id)
      ? [...matching, justSaved]
      : matching;

  const selected = options.find((credential) => credential.id === value);

  function save(input: CredentialFormValue) {
    setError(null);
    startTransition(async () => {
      const result = await saveCredentialAction(input);
      if (!result.ok) {
        setError(result.error ?? 'That could not be saved.');
        return;
      }

      if (result.id) {
        setJustSaved({ id: result.id, name: input.name.trim(), type: input.type });
        onChange(result.id);
      }
      setEditing(null);
      router.refresh();
    });
  }

  return (
    <>
      <Field label={label} hint={hint}>
        <div className="flex items-center gap-1.5">
          <Select
            value={value}
            onChange={(event) => onChange(event.target.value || undefined)}
            className="min-w-0 flex-1"
          >
            <option value="">None</option>
            {options.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name}
              </option>
            ))}
          </Select>

          {/* A type this build does not define has no form to open. */}
          {definition ? (
            <>
              <Button
                size="sm"
                className="shrink-0"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setEditing({});
                }}
                aria-label={`New ${definition.displayName} credential`}
                title={`New ${definition.displayName} credential`}
              >
                <Plus className="size-3.5" />
              </Button>

              <Button
                size="sm"
                className="shrink-0"
                disabled={pending || !selected}
                onClick={() => {
                  setError(null);
                  setEditing({ id: value });
                }}
                aria-label={selected ? `Replace ${selected.name}` : 'Replace credential'}
                title="Replace the selected credential"
              >
                <Pencil className="size-3.5" />
              </Button>
            </>
          ) : null}
        </div>

        {options.length === 0 && definition ? (
          <span className="block text-xs text-ink-faint">
            No {definition.displayName} credential yet. Add one with the + button.
          </span>
        ) : null}

        {!definition ? (
          <span className="block text-xs text-bad">
            This build does not define a <code className="font-mono">{credentialType}</code> credential type.
          </span>
        ) : null}
      </Field>

      {editing && definition ? (
        <div
          className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-surface-0/70 p-4 pt-16"
          onClick={() => !pending && setEditing(null)}
        >
          <div className="w-full max-w-md" onClick={(event) => event.stopPropagation()}>
            {error ? (
              <p className="mb-2 rounded-md border border-bad/25 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>
            ) : null}

            <CredentialForm
              // Only the type this input accepts, so the credential cannot be
              // created as something the node will not take.
              types={[definition]}
              initial={{ id: editing.id, type: credentialType }}
              existingName={options.find((credential) => credential.id === editing.id)?.name}
              pending={pending}
              onCancel={() => setEditing(null)}
              onSave={save}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
