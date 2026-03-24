import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, encryptDbField, decryptDbField } from '../crypto';

describe('crypto', () => {
  const testData = JSON.stringify({ name: 'Test Schuldner', aktenzeichen: '123 IN 456/26' });
  const password = 'sicheres-test-passwort-2026';

  it('encrypt/decrypt roundtrip', () => {
    const encrypted = encrypt(testData, password);
    const decrypted = decrypt(encrypted, password);
    expect(decrypted).toBe(testData);
  });

  it('encrypted payload has required fields', () => {
    const encrypted = encrypt(testData, password);
    expect(encrypted.salt).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.authTag).toBeTruthy();
    expect(encrypted.data).toBeTruthy();
    // Encrypted data should differ from plaintext
    expect(Buffer.from(encrypted.data, 'base64').toString('utf8')).not.toBe(testData);
  });

  it('rejects wrong password', () => {
    const encrypted = encrypt(testData, password);
    expect(() => decrypt(encrypted, 'falsches-passwort')).toThrow();
  });

  it('detects tampered data (authTag integrity)', () => {
    const encrypted = encrypt(testData, password);
    // Flip a byte in the encrypted data
    const dataBuffer = Buffer.from(encrypted.data, 'base64');
    dataBuffer[0] ^= 0xff;
    encrypted.data = dataBuffer.toString('base64');
    expect(() => decrypt(encrypted, password)).toThrow();
  });

  it('detects tampered authTag', () => {
    const encrypted = encrypt(testData, password);
    const tagBuffer = Buffer.from(encrypted.authTag, 'base64');
    tagBuffer[0] ^= 0xff;
    encrypted.authTag = tagBuffer.toString('base64');
    expect(() => decrypt(encrypted, password)).toThrow();
  });

  it('produces different ciphertext for same plaintext (random salt/iv)', () => {
    const encrypted1 = encrypt(testData, password);
    const encrypted2 = encrypt(testData, password);
    expect(encrypted1.salt).not.toBe(encrypted2.salt);
    expect(encrypted1.iv).not.toBe(encrypted2.iv);
    expect(encrypted1.data).not.toBe(encrypted2.data);
  });

  it('handles large JSON payloads', () => {
    const largeData = JSON.stringify({ items: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: 'x'.repeat(100) })) });
    const encrypted = encrypt(largeData, password);
    const decrypted = decrypt(encrypted, password);
    expect(decrypted).toBe(largeData);
  });

  it('handles unicode content', () => {
    const unicodeData = JSON.stringify({ name: 'Müller-Schröder', stadt: 'Nürnberg', straße: 'Königstraße 42' });
    const encrypted = encrypt(unicodeData, password);
    const decrypted = decrypt(encrypted, password);
    expect(decrypted).toBe(unicodeData);
  });
});

describe('encryptDbField / decryptDbField', () => {
  const serverKey = 'a2c5f31b9f9f4ac80560ce986844c8a00090645e7dec455f7f1a2bfc8bf5df03';
  const testJson = JSON.stringify({ aktenzeichen: '23 IN 165/25', name: 'Müller' });

  it('roundtrip encrypt/decrypt', () => {
    const encrypted = encryptDbField(testJson, serverKey);
    expect(encrypted.startsWith('$ENC$')).toBe(true);
    const decrypted = decryptDbField(encrypted, serverKey);
    expect(decrypted).toBe(testJson);
  });

  it('returns legacy unencrypted data as-is', () => {
    const legacy = '{"name":"test"}';
    const result = decryptDbField(legacy, serverKey);
    expect(result).toBe(legacy);
  });

  it('produces different ciphertext each time (random IV)', () => {
    const e1 = encryptDbField(testJson, serverKey);
    const e2 = encryptDbField(testJson, serverKey);
    expect(e1).not.toBe(e2);
  });

  it('rejects wrong key', () => {
    const encrypted = encryptDbField(testJson, serverKey);
    expect(() => decryptDbField(encrypted, 'wrong-key-that-is-at-least-32-characters-long')).toThrow();
  });

  it('detects tampered ciphertext', () => {
    const encrypted = encryptDbField(testJson, serverKey);
    const parts = encrypted.split('.');
    const dataBuffer = Buffer.from(parts[2], 'base64');
    dataBuffer[0] ^= 0xff;
    parts[2] = dataBuffer.toString('base64');
    const tampered = parts.join('.');
    expect(() => decryptDbField(tampered, serverKey)).toThrow();
  });
});
