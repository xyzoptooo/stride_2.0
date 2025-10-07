import crypto from 'crypto';
import { env } from '../config/environment.js';
import { logger } from './logger.js';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const resolveKey = () => {
  if (!env.REMINDER_ENCRYPTION_KEY) {
    logger.warn('REMINDER_ENCRYPTION_KEY is not set; reminder metadata will be stored in plain text.');
    return null;
  }
  const buffer = Buffer.from(env.REMINDER_ENCRYPTION_KEY, 'base64');
  if (buffer.length !== KEY_LENGTH) {
    logger.error('REMINDER_ENCRYPTION_KEY must be a 32-byte value encoded in base64.');
    throw new Error('Invalid REMINDER_ENCRYPTION_KEY length.');
  }
  return buffer;
};

const encryptionKey = resolveKey();

export const encrypt = (payload) => {
  if (!encryptionKey || payload === undefined || payload === null) {
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ciphertext = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
};

export const decrypt = (token) => {
  if (!token) return null;
  if (!encryptionKey) {
    try {
      return JSON.parse(token);
    } catch (error) {
      return token;
    }
  }

  const buffer = Buffer.from(token, 'base64');
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

  try {
    return JSON.parse(plaintext);
  } catch (error) {
    return plaintext;
  }
};
