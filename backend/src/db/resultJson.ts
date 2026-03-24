import { config } from '../config';
import { encryptDbField, decryptDbField } from '../utils/crypto';

/**
 * Encrypt a JSON object for storage in result_json.
 * Returns an encrypted string that can be stored in SQLite.
 */
export function writeResultJson(data: unknown): string {
  const json = JSON.stringify(data);
  return encryptDbField(json, config.DB_ENCRYPTION_KEY);
}

/**
 * Decrypt and parse result_json from the database.
 * Handles both encrypted ($ENC$...) and legacy unencrypted JSON transparently.
 * Returns null if the input is null/undefined.
 */
export function readResultJson<T = unknown>(stored: string | null | undefined): T | null {
  if (!stored) return null;
  const json = decryptDbField(stored, config.DB_ENCRYPTION_KEY);
  return JSON.parse(json) as T;
}
