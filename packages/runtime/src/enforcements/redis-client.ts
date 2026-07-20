/**
 * TransparentGuard Runtime — Redis Client (optional, lazy-initialized)
 *
 * Used by token-budget and rate-limit enforcers for shared state across replicas.
 * If TG_REDIS_URL is not set, all callers receive null and fall back to in-process state.
 * Requires: npm install ioredis  (optional peer dependency)
 */

interface RedisEvalable {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  ping(): Promise<string>;
}

let _client: RedisEvalable | null = null;
let _initDone = false;
let _initPromise: Promise<RedisEvalable | null> | null = null;

async function initRedis(): Promise<RedisEvalable | null> {
  const url = process.env["TG_REDIS_URL"];
  if (!url) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ioredis = require("ioredis") as {
      Redis: new (url: string, opts: object) => RedisEvalable & { connect?(): Promise<void> };
    };
    const client = new ioredis.Redis(url, {
      connectTimeout: 2000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    if (client.connect) await client.connect();
    await client.ping();
    return client;
  } catch (err) {
    console.warn(
      `[TransparentGuard] TG_REDIS_URL is set but Redis connection failed: ${String(err)}. ` +
      "Token budget and rate limits will use per-process counters. " +
      "Limits may be exceeded in multi-replica deployments.",
    );
    return null;
  }
}

export async function getRedisClient(): Promise<RedisEvalable | null> {
  if (_initDone) return _client;
  if (_initPromise) return _initPromise;

  _initPromise = initRedis().then((c) => {
    _client = c;
    _initDone = true;
    _initPromise = null;
    return c;
  });

  return _initPromise;
}
