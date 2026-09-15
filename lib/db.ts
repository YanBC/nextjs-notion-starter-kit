import Keyv from '@keyvhq/core'
import KeyvRedis from '@keyvhq/redis'

import { isRedisEnabled, redisNamespace, redisUrl } from './config'

let db: Keyv

if (isRedisEnabled && redisUrl) {
  const keyvRedis = new KeyvRedis(redisUrl)
  db = new Keyv({ store: keyvRedis, namespace: redisNamespace || undefined })
} else {
  if (isRedisEnabled) {
    console.warn(
      'redis is enabled but neither REDIS_URL nor REDIS_HOST is set; falling back to an in-memory cache'
    )
  }

  db = new Keyv()
}

// Keyv re-emits store errors on itself. 'error' is special on an EventEmitter:
// with no listener attached, a single Redis blip throws an uncaught exception
// and takes down the whole lambda, 500ing every request it was serving. Every
// caller already treats cache access as best-effort, so a warning is enough.
db.on('error', (err) => console.warn('keyv error', err))

export { db }
