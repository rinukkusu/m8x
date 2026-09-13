import { decryptJson, encryptJson } from './crypto.js';
import { prisma } from './db.js';

/**
 * Credential storage.
 *
 * Secrets are encrypted at rest and only ever decrypted inside the worker.
 * Nothing in this file returns plaintext to a caller that is not the runner:
 * the listing used by the editor deliberately returns names and types only.
 */

export interface CredentialTypeField {
  name: string;
  displayName: string;
  type: 'string' | 'password' | 'select';
  options?: Array<{ label: string; value: string }>;
  showIf?: Record<string, string[]>;
}

export interface CredentialType {
  type: string;
  displayName: string;
  fields: CredentialTypeField[];
}

export const CREDENTIAL_TYPES: CredentialType[] = [
  {
    type: 'httpAuth',
    displayName: 'HTTP authentication',
    fields: [
      {
        name: 'authType',
        displayName: 'Kind',
        type: 'select',
        options: [
          { label: 'Bearer token', value: 'bearer' },
          { label: 'Basic auth', value: 'basic' },
          { label: 'Custom header', value: 'header' },
        ],
      },
      { name: 'token', displayName: 'Token', type: 'password', showIf: { authType: ['bearer'] } },
      { name: 'username', displayName: 'Username', type: 'string', showIf: { authType: ['basic'] } },
      { name: 'password', displayName: 'Password', type: 'password', showIf: { authType: ['basic'] } },
      { name: 'headerName', displayName: 'Header name', type: 'string', showIf: { authType: ['header'] } },
      { name: 'headerValue', displayName: 'Header value', type: 'password', showIf: { authType: ['header'] } },
    ],
  },
  {
    type: 'telegramApi',
    displayName: 'Telegram bot',
    fields: [{ name: 'botToken', displayName: 'Bot token', type: 'password' }],
  },
  // Receiving and sending are separate credentials rather than one mail
  // account, because the two run on different hosts and ports at most
  // providers, and plenty of setups have only one of them.
  {
    type: 'imap',
    displayName: 'IMAP (incoming mail)',
    fields: [
      { name: 'host', displayName: 'Host', type: 'string' },
      { name: 'port', displayName: 'Port', type: 'string' },
      {
        name: 'security',
        displayName: 'Security',
        type: 'select',
        options: [
          { label: 'TLS (usually port 993)', value: 'tls' },
          { label: 'STARTTLS (usually port 143)', value: 'starttls' },
          { label: 'None', value: 'none' },
        ],
      },
      { name: 'user', displayName: 'Username', type: 'string' },
      { name: 'password', displayName: 'Password', type: 'password' },
      {
        name: 'allowSelfSigned',
        displayName: 'Accept self-signed certificates',
        type: 'select',
        options: [
          { label: 'No', value: 'no' },
          { label: 'Yes', value: 'yes' },
        ],
      },
    ],
  },
  {
    type: 'smtp',
    displayName: 'SMTP (outgoing mail)',
    fields: [
      { name: 'host', displayName: 'Host', type: 'string' },
      { name: 'port', displayName: 'Port', type: 'string' },
      {
        name: 'security',
        displayName: 'Security',
        type: 'select',
        options: [
          { label: 'TLS (usually port 465)', value: 'tls' },
          { label: 'STARTTLS (usually port 587)', value: 'starttls' },
          { label: 'None', value: 'none' },
        ],
      },
      { name: 'user', displayName: 'Username', type: 'string' },
      { name: 'password', displayName: 'Password', type: 'password' },
      {
        name: 'from',
        displayName: 'Default From',
        type: 'string',
      },
      {
        name: 'allowSelfSigned',
        displayName: 'Accept self-signed certificates',
        type: 'select',
        options: [
          { label: 'No', value: 'no' },
          { label: 'Yes', value: 'yes' },
        ],
      },
    ],
  },
];

export interface CredentialSummary {
  id: string;
  name: string;
  type: string;
  updatedAt: Date;
}

/** Names and types only. The values never leave the worker. */
export async function listCredentials(type?: string): Promise<CredentialSummary[]> {
  return prisma.credential.findMany({
    where: type ? { type } : undefined,
    select: { id: true, name: true, type: true, updatedAt: true },
    orderBy: { name: 'asc' },
  });
}

export async function saveCredential(input: {
  id?: string;
  name: string;
  type: string;
  data: Record<string, string>;
}): Promise<string> {
  const encrypted = encryptJson(input.data);

  if (input.id) {
    const updated = await prisma.credential.update({
      where: { id: input.id },
      data: { name: input.name.trim(), type: input.type, data: encrypted },
      select: { id: true },
    });
    return updated.id;
  }

  const created = await prisma.credential.create({
    data: { name: input.name.trim(), type: input.type, data: encrypted },
    select: { id: true },
  });
  return created.id;
}

/** Called by the runner. This is the only path that decrypts. */
export async function loadCredentialData(credentialId: string): Promise<Record<string, string> | null> {
  const credential = await prisma.credential.findUnique({
    where: { id: credentialId },
    select: { data: true },
  });
  if (!credential) return null;
  return decryptJson(credential.data);
}

export async function deleteCredential(credentialId: string): Promise<void> {
  await prisma.credential.delete({ where: { id: credentialId } });
}
