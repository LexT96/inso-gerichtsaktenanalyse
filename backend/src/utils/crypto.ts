import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 32;
const IV_LENGTH = 16;

// Prefix for encrypted DB fields so we can detect unencrypted (legacy) data
const DB_ENCRYPTED_PREFIX = '$ENC$';

interface EncryptedPayload {
  salt: string;
  iv: string;
  authTag: string;
  data: string;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

// --- Password-based encryption (for .iae export/import) ---

export function encrypt(plaintext: string, password: string): EncryptedPayload {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

export function decrypt(payload: EncryptedPayload, password: string): string {
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const encryptedData = Buffer.from(payload.data, 'base64');
  const key = deriveKey(password, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

  return decrypted.toString('utf8');
}

// --- Server-key encryption (for database at-rest encryption of result_json) ---

function deriveDbKey(hexKey: string): Buffer {
  const raw = Buffer.from(hexKey, 'utf8');
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypt plaintext with a server-held key. Returns a compact string:
 * $ENC$<iv:base64>.<authTag:base64>.<ciphertext:base64>
 */
export function encryptDbField(plaintext: string, hexKey: string): string {
  const key = deriveDbKey(hexKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${DB_ENCRYPTED_PREFIX}${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

/**
 * Decrypt a value produced by encryptDbField.
 * If the value doesn't start with $ENC$, returns it as-is (unencrypted legacy data).
 */
export function decryptDbField(stored: string, hexKey: string): string {
  if (!stored.startsWith(DB_ENCRYPTED_PREFIX)) {
    return stored;
  }

  const payload = stored.slice(DB_ENCRYPTED_PREFIX.length);
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Ungültiges verschlüsseltes Datenbankfeld');

  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const encryptedData = Buffer.from(parts[2], 'base64');
  const key = deriveDbKey(hexKey);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

  return decrypted.toString('utf8');
}
