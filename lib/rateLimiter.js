/**
 * Rate Limiter
 *
 * Applies a sliding-window rate limit of 30 requests/minute to POST /v1/reviews.
 * GET requests are never rate limited.
 *
 * On limit exceeded: 429 with Retry-After header (seconds until oldest request expires).
 */

const RATE_LIMIT = 30;        // max requests per window
const WINDOW_MS = 60 * 1000;  // 1 minute in milliseconds

// Map: clientKey -> Array<timestamp> (timestamps of requests within window)
const requestLog = new Map();

/**
 * Returns a client key from the request (IP-based).
 * @param {object} req - Express request
 * @returns {string}
 */
function getClientKey(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * Express middleware: rate limit POST /v1/reviews only.
 * GETs are always allowed through immediately.
 */
export function rateLimitMiddleware(req, res, next) {
  // Only rate limit POST method
  if (req.method !== 'POST') {
    return next();
  }

  const now = Date.now();
  const key = getClientKey(req);

  // Get or create request log for this client
  if (!requestLog.has(key)) {
    requestLog.set(key, []);
  }

  const timestamps = requestLog.get(key);

  // Remove timestamps outside the current window
  const windowStart = now - WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] <= windowStart) {
    timestamps.shift();
  }

  if (timestamps.length >= RATE_LIMIT) {
    // Calculate seconds until oldest request leaves the window
    const oldestTs = timestamps[0];
    const retryAfterMs = (oldestTs + WINDOW_MS) - now;
    const retryAfterSecs = Math.max(1, Math.ceil(retryAfterMs / 1000));

    res.setHeader('Retry-After', retryAfterSecs);
    return res.status(429).json({
      error: {
        code: 'rate_limited',
        message: `Rate limit exceeded. Maximum ${RATE_LIMIT} requests per minute. Retry after ${retryAfterSecs} seconds.`
      }
    });
  }

  // Record this request
  timestamps.push(now);
  next();
}
