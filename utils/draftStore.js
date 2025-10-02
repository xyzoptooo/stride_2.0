import Redis from 'ioredis';
import { env } from '../config/environment.js';

let redisClient = null;
if (env.REDIS_URL) {
  redisClient = new Redis(env.REDIS_URL);
  redisClient.on('error', (err) => console.warn('Redis error:', err));
}

const ensureRedis = () => {
  if (!redisClient) throw new Error('Redis is not configured (REDIS_URL missing)');
  return redisClient;
};

export async function saveDraft(draft) {
  const client = ensureRedis();
  const key = `onboard:draft:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
  const value = JSON.stringify(draft);
  await client.set(key, value, 'EX', env.DRAFT_TTL_SECONDS);
  return key;
}

export async function getDraft(key) {
  const client = ensureRedis();
  const data = await client.get(key);
  return data ? JSON.parse(data) : null;
}

export async function deleteDraft(key) {
  const client = ensureRedis();
  await client.del(key);
}

export { redisClient };
