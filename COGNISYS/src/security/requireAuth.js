const jwt = require('jsonwebtoken');
const db = require('../../database');

async function requireAuth(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const parts = auth.split(' ');
    if (parts[0] !== 'Bearer' || !parts[1]) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'Server misconfigured: JWT_SECRET not set' });
    }
    const payload = jwt.verify(parts[1], secret);
    
    // Ensure user exists in database (handles DB resets gracefully)
    const user = await db.findOrCreateUser(
      payload.sub,
      payload.email || `${payload.sub}@cognisys.ai`,
      payload.name || 'User'
    );
    
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name
    };
    
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const parts = auth.split(' ');
    if (parts[0] === 'Bearer' && parts[1]) {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        return res.status(500).json({ error: 'Server misconfigured: JWT_SECRET not set' });
      }
      const payload = jwt.verify(parts[1], secret);
      req.user = { id: payload.sub, email: payload.email, name: payload.name };
    }
  } catch (e) {}
  next();
}

module.exports = { requireAuth, optionalAuth };