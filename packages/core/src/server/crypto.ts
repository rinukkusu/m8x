import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.M8X_ENCRYPTION_KEY;
  if (!raw || raw.startsWith('CHANGE_ME')) {
    // Failing at startup is the point. A placeholder key that silently "works"
    // would mean every credential in the database is readable by anyone who
    // can read the repository.
    throw new Error(
      'M8X_ENCRYPTION_KEY is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`M8X_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}.`);
  }

  cachedKey = key;
  return key;
}

/**
 * Stored format: `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 *
 * The version prefix is there so a future key rotation can tell old records
 * from new ones without a migration that has to decrypt everything at once.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(stored: string): string {
  const [version, ivPart, tagPart, dataPart] = stored.split('.');

  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('The stored credential is not in a format this version understands.');
  }

  const tag = Buffer.from(tagPart, 'base64url');
  if (tag.length !== TAG_LENGTH) throw new Error('The stored credential has a malformed auth tag.');

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM authentication failing means either the ciphertext was tampered with
    // or the key changed. Both are worth saying out loud.
    throw new Error('Could not decrypt the credential. The encryption key may have changed.');
  }
}

export function encryptJson(value: Record<string, unknown>): string {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson(stored: string): Record<string, string> {
  return JSON.parse(decryptSecret(stored)) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Password hashing
//
// scrypt from the standard library rather than argon2 or bcrypt: no native
// build step, no dependency, and it is a memory-hard KDF. Single-team
// deployment, a handful of accounts.
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `scrypt.${SCRYPT_COST}.${salt.toString('base64url')}.${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, costPart, saltPart, hashPart] = stored.split('.');
  if (scheme !== 'scrypt' || !costPart || !saltPart || !hashPart) return false;

  const expected = Buffer.from(hashPart, 'base64url');
  const derived = scryptSync(password, Buffer.from(saltPart, 'base64url'), expected.length, {
    N: Number(costPart),
  });

  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
