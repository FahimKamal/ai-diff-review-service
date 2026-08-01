import { createHash } from 'crypto';

/**
 * Cache & Idempotency Manager
 */

// Idempotency store: key -> { bodyHash: string, jobId: string }
const idempotencyStore = new Map();

// Payload cache store: payloadHash -> jobId
const payloadCacheStore = new Map();

/**
 * Computes SHA-256 hash of a string or buffer.
 * @param {string|Buffer} data
 * @returns {string} hex hash
 */
export function hashData(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Computes canonical hash of { diff, options } payload for caching.
 * @param {string} diff
 * @param {object} options
 * @returns {string} payload hash
 */
export function hashPayload(diff, options = {}) {
  const canonical = JSON.stringify({
    diff,
    options: {
      provider: options.provider || 'mock',
      maxFindings: typeof options.maxFindings === 'number' ? options.maxFindings : 100
    }
  });
  return hashData(canonical);
}

/**
 * Checks idempotency key status.
 * @param {string} key - Idempotency-Key header value
 * @param {string} rawBodyString - Raw request body string
 * @returns {{ match: boolean, conflict: boolean, existingJobId: string|null }}
 */
export function checkIdempotency(key, rawBodyString) {
  if (!key) {
    return { match: false, conflict: false, existingJobId: null };
  }

  const bodyHash = hashData(rawBodyString);
  const existing = idempotencyStore.get(key);

  if (!existing) {
    return { match: false, conflict: false, existingJobId: null };
  }

  if (existing.bodyHash === bodyHash) {
    // Same key + byte-identical body -> return same jobId
    return { match: true, conflict: false, existingJobId: existing.jobId };
  } else {
    // Same key + different body -> 409 Conflict
    return { match: false, conflict: true, existingJobId: null };
  }
}

/**
 * Saves an idempotency key mapping.
 * @param {string} key
 * @param {string} rawBodyString
 * @param {string} jobId
 */
export function saveIdempotency(key, rawBodyString, jobId) {
  if (!key) return;
  const bodyHash = hashData(rawBodyString);
  idempotencyStore.set(key, { bodyHash, jobId });
}

/**
 * Checks payload cache for duplicate {diff, options}.
 * @param {string} diff
 * @param {object} options
 * @returns {string|null} cached jobId if present, else null
 */
export function getCachedJobId(diff, options) {
  const payloadHash = hashPayload(diff, options);
  return payloadCacheStore.get(payloadHash) || null;
}

/**
 * Saves payload hash mapping to cache.
 * @param {string} diff
 * @param {object} options
 * @param {string} jobId
 */
export function savePayloadCache(diff, options, jobId) {
  const payloadHash = hashPayload(diff, options);
  payloadCacheStore.set(payloadHash, jobId);
}
