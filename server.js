import express from 'express';
import { authMiddleware } from './lib/auth.js';
import { rateLimitMiddleware } from './lib/rateLimiter.js';
import { isValidDiff } from './lib/diffParser.js';
import { createJob, enqueueJob, getJob } from './lib/jobManager.js';
import { checkIdempotency, saveIdempotency, getCachedJobId, savePayloadCache } from './lib/cache.js';
import { attachSSEClient } from './lib/sseManager.js';

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats a standard error envelope.
 * @param {string} code - machine code
 * @param {string} message - human readable text
 * @returns {object}
 */
export function formatError(code, message) {
  return { error: { code, message } };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Parse JSON bodies with a strict 1 MiB limit
app.use(express.json({
  limit: 1048576,
  // Keep the raw body string for idempotency key hashing
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// Handle body-parser errors (payload too large, invalid JSON) BEFORE any route
app.use((err, req, res, next) => {
  if (err) {
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json(formatError(
        'payload_too_large',
        'Payload exceeds the maximum allowed size of 1 MiB (1,048,576 bytes).'
      ));
    }
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json(formatError(
        'invalid_json',
        'Request body contains invalid JSON syntax.'
      ));
    }
  }
  next(err);
});

// ---------------------------------------------------------------------------
// Public routes (no auth required)
// ---------------------------------------------------------------------------

// GET /health
app.get('/health', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  res.status(200).json({
    status: 'ok',
    version: '1.0.0',
    uptimeSeconds
  });
});

// GET /spec
app.get('/spec', (req, res) => {
  res.status(200).json({
    specVersion: '1.0',
    providers: ['mock', 'llm'],
    limits: {
      maxPayloadBytes: 1048576,
      chunkBytes: 65536,
      maxConcurrentJobs: 4,
      rateLimitPerMinute: 30
    }
  });
});

// ---------------------------------------------------------------------------
// Protected /v1/* routes — require Bearer token auth
// ---------------------------------------------------------------------------

const v1 = express.Router();

// Apply auth to all v1 routes (including GET)
v1.use(authMiddleware);

// ---------------------------------------------------------------------------
// POST /v1/reviews — Submit a diff for async review
// ---------------------------------------------------------------------------

v1.post('/reviews', rateLimitMiddleware, async (req, res) => {
  // req.body may be undefined if Content-Type is not application/json or body is empty
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json(formatError(
      'invalid_json',
      'Request body must be valid JSON.'
    ));
  }

  const { diff, options = {} } = req.body;

  // Validate diff field
  if (!diff || typeof diff !== 'string' || diff.trim() === '') {
    return res.status(422).json(formatError(
      'invalid_diff',
      'The "diff" field is required and must be a non-empty string.'
    ));
  }

  if (!isValidDiff(diff)) {
    return res.status(422).json(formatError(
      'invalid_diff',
      'The provided "diff" is not parseable as a unified diff.'
    ));
  }

  // Normalize options (unknown fields are ignored per spec)
  const normalizedOptions = {
    provider: options.provider === 'llm' ? 'llm' : 'mock',
    maxFindings: typeof options.maxFindings === 'number' && options.maxFindings > 0
      ? Math.floor(options.maxFindings)
      : 100
  };

  // Raw body for idempotency hashing
  const rawBody = req.rawBody || JSON.stringify(req.body);
  const idempotencyKey = req.headers['idempotency-key'] || null;

  // Check idempotency key first
  if (idempotencyKey) {
    const idResult = checkIdempotency(idempotencyKey, rawBody);
    if (idResult.conflict) {
      return res.status(409).json(formatError(
        'idempotency_conflict',
        'An Idempotency-Key was previously used with a different request body.'
      ));
    }
    if (idResult.match) {
      // Same key + same body — return existing jobId (idempotent retry)
      const existingJob = getJob(idResult.existingJobId);
      if (existingJob) {
        return res.status(202).json({
          jobId: existingJob.jobId,
          status: existingJob.status
        });
      }
    }
  }

  // Check payload cache — byte-identical {diff, options} must not redo work
  const cachedJobId = getCachedJobId(diff, normalizedOptions);
  if (cachedJobId) {
    const cachedJob = getJob(cachedJobId);
    if (cachedJob) {
      // Mark job as a cache hit so polling reflects cacheHit: true
      cachedJob.usage.cacheHit = true;
      // Save idempotency key against this cached job if provided
      if (idempotencyKey) {
        saveIdempotency(idempotencyKey, rawBody, cachedJobId);
      }
      return res.status(202).json({
        jobId: cachedJobId,
        status: cachedJob.status
      });
    }
  }

  // Create new job
  const job = createJob(diff, normalizedOptions, false);

  // Persist idempotency mapping before enqueuing
  if (idempotencyKey) {
    saveIdempotency(idempotencyKey, rawBody, job.jobId);
  }

  // Persist payload cache mapping
  savePayloadCache(diff, normalizedOptions, job.jobId);

  // Enqueue for async processing
  enqueueJob(job.jobId);

  return res.status(202).json({
    jobId: job.jobId,
    status: 'queued'
  });
});

// ---------------------------------------------------------------------------
// GET /v1/reviews/:jobId — Poll job status and results
// ---------------------------------------------------------------------------

v1.get('/reviews/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json(formatError(
      'not_found',
      `No review job found with id: ${jobId}`
    ));
  }

  const response = {
    jobId: job.jobId,
    status: job.status,
    usage: {
      inputBytes: job.usage.inputBytes,
      chunks: job.usage.chunks,
      cacheHit: job.usage.cacheHit
    }
  };

  // Include findings only when job is done
  if (job.status === 'done') {
    response.findings = job.findings;
  }

  // Include error info when job failed
  if (job.status === 'failed' && job.error) {
    response.error = job.error;
  }

  return res.status(200).json(response);
});

// ---------------------------------------------------------------------------
// GET /v1/reviews/:jobId/stream — SSE event stream
// ---------------------------------------------------------------------------

v1.get('/reviews/:jobId/stream', (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);

  if (!job) {
    // Must return error envelope even for SSE endpoint
    return res.status(404).json(formatError(
      'not_found',
      `No review job found with id: ${jobId}`
    ));
  }

  // Hand off to SSE manager — it handles both live streaming and replay
  attachSSEClient(jobId, job, req, res);
});

// Mount v1 router
app.use('/v1', v1);

// ---------------------------------------------------------------------------
// Global error handler (catches any unhandled errors from routes)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json(formatError(
      'internal',
      'An unexpected internal error occurred.'
    ));
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`AI Diff Review Service listening on port ${PORT}`);
    console.log(`  Bearer token: ${process.env.BEARER_TOKEN || '(not set — using default-secret-token)'}`);
  });
}

export default app;
