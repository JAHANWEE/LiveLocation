
const USERS = {
  alice: { id: 'user_alice', username: 'alice', password: 'alice123', displayName: 'Alice' },
  bob:   { id: 'user_bob',   username: 'bob',   password: 'bob123',   displayName: 'Bob'   },
  carol: { id: 'user_carol', username: 'carol', password: 'carol123', displayName: 'Carol' },
};

/**
 * Validate credentials and return the user object or null.
 * @param {string} username
 * @param {string} password
 * @returns {{ id: string, username: string, displayName: string } | null}
 */
export function validateCredentials(username, password) {
  const user = USERS[username?.toLowerCase()];
  if (!user) return null;
  if (user.password !== password) return null;
  // Return a safe subset — never expose the password downstream
  return { id: user.id, username: user.username, displayName: user.displayName };
}

/**
 * Express middleware — rejects requests that have no authenticated session.
 * Redirects browsers to /login; returns 401 JSON for API calls.
 */
export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  const isApi = req.path.startsWith('/api/') || req.headers['accept']?.includes('application/json');
  if (isApi) return res.status(401).json({ error: 'Unauthenticated' });
  return res.redirect('/login');
}
