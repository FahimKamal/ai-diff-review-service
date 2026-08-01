/**
 * Middleware to validate Authorization: Bearer <token> for all /v1/* routes.
 * /health and /spec remain public.
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Missing or invalid Authorization header. Expected: "Authorization: Bearer <token>".'
      }
    });
  }

  const token = authHeader.substring(7).trim();
  const expectedToken = process.env.BEARER_TOKEN || 'default-secret-token';

  if (token !== expectedToken) {
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Invalid bearer token. Access denied.'
      }
    });
  }

  next();
}
