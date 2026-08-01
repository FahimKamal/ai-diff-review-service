import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

// Helper to format standardized error envelopes
export function formatError(code, message) {
  return { error: { code, message } };
}

// JSON body parser with 1 MiB payload limit
app.use(express.json({ limit: 1048576 }));

// Custom middleware to catch body parser errors (invalid JSON or payload too large)
app.use((err, req, res, next) => {
  if (err) {
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json(formatError('payload_too_large', 'Payload exceeds maximum size of 1 MiB (1048576 bytes)'));
    }
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json(formatError('invalid_json', 'Invalid JSON syntax in request body'));
    }
    return res.status(400).json(formatError('invalid_json', err.message || 'Bad request'));
  }
  next();
});

// GET /health (public)
app.get('/health', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  res.status(200).json({
    status: 'ok',
    version: '1.0.0',
    uptimeSeconds
  });
});

// GET /spec (public)
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

// Start server if main module
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`AI Diff Review Service listening on port ${PORT}`);
  });
}

export default app;
