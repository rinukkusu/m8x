import { CREDENTIAL_TYPES, listCredentials } from '@m8x/core/server';

import { CredentialManager } from '@/components/credential-manager';
import { PageHeader } from '@/components/ui';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function CredentialsPage() {
  await requireUser();

  const credentials = await listCredentials();

  return (
    <>
      <PageHeader
        title="Credentials"
        description="Secrets are encrypted at rest and only decrypted inside the worker. They are never sent back to this page."
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <CredentialManager
          types={CREDENTIAL_TYPES}
          credentials={credentials.map((credential) => ({
            id: credential.id,
            name: credential.name,
            type: credential.type,
            updatedAt: credential.updatedAt.toISOString(),
          }))}
        />
      </div>
    </>
  );
}
