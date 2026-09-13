'use client';

import type { CredentialType } from '@m8x/core/server';
import { useState } from 'react';

import { Button, Field, Input, Select } from './ui';

export interface CredentialFormValue {
  id?: string;
  name: string;
  type: string;
  data: Record<string, string>;
}

/**
 * The fields for one credential, driven by its type definition.
 *
 * Lives on its own because two places need it: the Credentials page, and the
 * picker inside a node's inspector that creates one without leaving the canvas.
 */
export function CredentialForm({
  types,
  initial,
  existingName,
  onCancel,
  onSave,
  pending,
}: {
  types: CredentialType[];
  initial: { id?: string; type: string };
  existingName?: string;
  onCancel: () => void;
  onSave: (input: CredentialFormValue) => void;
  pending?: boolean;
}) {
  const [type, setType] = useState(initial.type);
  const [name, setName] = useState(existingName ?? '');
  const [data, setData] = useState<Record<string, string>>({});

  const definition = types.find((entry) => entry.type === type) ?? types[0]!;

  const visibleFields = definition.fields.filter((field) => {
    if (!field.showIf) return true;
    return Object.entries(field.showIf).every(([key, allowed]) => allowed.includes(data[key] ?? ''));
  });

  return (
    <div className="card space-y-4 p-4">
      <p className="text-sm font-medium text-ink">{initial.id ? 'Replace credential' : 'New credential'}</p>

      {initial.id ? (
        <p className="rounded-md border border-line bg-surface-0 px-3 py-2 text-xs text-ink-faint">
          Existing values are not shown, because they never leave the worker. Saving replaces them entirely.
        </p>
      ) : null}

      <Field label="Name">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Stripe production" />
      </Field>

      <Field label="Type">
        <Select
          value={type}
          onChange={(event) => {
            setType(event.target.value);
            setData({});
          }}
          // A credential's type decides which fields exist, so changing it on an
          // existing one would silently orphan whatever is stored. It is also
          // fixed when the picker opened this form for a specific node input.
          disabled={Boolean(initial.id) || types.length === 1}
        >
          {types.map((entry) => (
            <option key={entry.type} value={entry.type}>
              {entry.displayName}
            </option>
          ))}
        </Select>
      </Field>

      {visibleFields.map((field) => (
        <Field key={field.name} label={field.displayName}>
          {field.type === 'select' ? (
            <Select
              value={data[field.name] ?? ''}
              onChange={(event) => setData((current) => ({ ...current, [field.name]: event.target.value }))}
            >
              <option value="">Choose one</option>
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              type={field.type === 'password' ? 'password' : 'text'}
              autoComplete="off"
              value={data[field.name] ?? ''}
              onChange={(event) => setData((current) => ({ ...current, [field.name]: event.target.value }))}
            />
          )}
        </Field>
      ))}

      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={() => onSave({ id: initial.id, name, type, data })} disabled={pending}>
          Save
        </Button>
      </div>
    </div>
  );
}
