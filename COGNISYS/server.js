const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

dotenv.config({ path: path.join(__dirname, '.env') });

const { initDB, findOrCreateUser, saveRefreshToken, getRefreshToken, deleteRefreshToken } = require('./database');
const chatRoutes = require('./routes/chat');
const authRoutes = require('./routes/auth');
const { requireAuth } = require('./src/security/requireAuth');

const app = express();
const PORT = process.env.PORT || 3000;

// Validate required secrets at startup
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}
if (!process.env.JWT_REFRESH_SECRET) {
  console.error('FATAL: JWT_REFRESH_SECRET environment variable is required');
  process.exit(1);
}

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/refresh',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

// Security
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Rate limiting - separate limits for different endpoints
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  message: { error: 'Too many login attempts, please try again later.' }
});

const chatLimiter = rateLimit({
  windowMs: 60000, // 1 minute
  max: 10, // 10 requests per minute
  message: { error: 'Too many chat requests, please wait.' }
});

const apiLimiter = rateLimit({
  windowMs: 60000,
  max: 60,
  message: { error: 'Too many requests, please wait.' }
});

app.use('/api/', apiLimiter);

// Public routes - stricter rate limit for login
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    const id = uuidv4();
    const name = email ? email.split('@')[0] : 'Guest';
    const user = await findOrCreateUser(id, email || `${id}@guest.cognisys`, name);

    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRY || '24h' }
    );

    const refreshToken = jwt.sign(
      { sub: user.id, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d' }
    );

    // Store refresh token in database and HTTP-only cookie
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await saveRefreshToken(user.id, refreshToken, expiresAt);
    
    res.cookie('cognisys_refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);

    res.json({
      access_token: accessToken,
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan }
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Refresh endpoint with token rotation
app.post('/api/refresh', async (req, res) => {
  const refreshToken = req.cookies?.cognisys_refresh_token;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  try {
    // Verify the token first
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    
    // Check if token exists in database
    const storedToken = await getRefreshToken(refreshToken);
    if (!storedToken) {
      res.clearCookie('cognisys_refresh_token', REFRESH_COOKIE_OPTIONS);
      return res.status(401).json({ error: 'Refresh token not found or expired' });
    }
    
    // Immediately invalidate/delete old token (rotation)
    await deleteRefreshToken(refreshToken);
    
    // Issue new access token
    const accessToken = jwt.sign(
      { sub: payload.sub },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRY || '24h' }
    );
    
    // Issue new refresh token
    const newRefreshToken = jwt.sign(
      { sub: payload.sub, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d' }
    );
    
    // Store new refresh token in DB
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await saveRefreshToken(payload.sub, newRefreshToken, expiresAt);
    
    // Set new HTTP-only cookie
    res.cookie('cognisys_refresh_token', newRefreshToken, REFRESH_COOKIE_OPTIONS);
    
    res.json({ access_token: accessToken });
  } catch (e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      res.clearCookie('cognisys_refresh_token', REFRESH_COOKIE_OPTIONS);
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    console.error('Refresh error:', e);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Logout — clear refresh cookie and delete token from DB
app.post('/api/logout', async (req, res) => {
  const refreshToken = req.cookies?.cognisys_refresh_token;
  if (refreshToken) {
    await deleteRefreshToken(refreshToken);
  }
  res.clearCookie('cognisys_refresh_token', REFRESH_COOKIE_OPTIONS);
  res.json({ message: 'Logged out' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Protected routes
app.use('/api', requireAuth, chatRoutes);
app.use('/api', requireAuth, authRoutes);

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`CognisysAI running on http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error('Failed to start:', e);
    process.exit(1);
  }
}

start();