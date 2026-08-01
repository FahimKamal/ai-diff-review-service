import { formatError } from '../server.js';

/**
 * Middleware to validate Authorization: Bearer <token> for all /v1/* routes.
 * /health and /spec remain public.
 */
export function authMiddleware(req, res, next) {
  // Only protect /v1 routes
  if (!req.path.startsWith('/v1')) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json(formatError('unauthorized', 'Missing or invalid Authorization header. Expected "Bearer <token>".'));
  }

  const token = authHeader.substring(7).trim();
  const expectedToken = process.env.BEARER_TOKEN || 'default-secret-token';

  if (token !== expectedToken) {
    return res.status(401).json(formatError('unauthorized', 'Invalid bearer token. Access denied.'));
  }

  next();
}
