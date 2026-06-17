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

const { initDB, findOrCreateUser } = require('./database');
const chatRoutes = require('./routes/chat');
const authRoutes = require('./routes/auth');
const { requireAuth } = require('./src/security/requireAuth');

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60000,
  max: 60,
  message: { error: 'Too many requests, please wait.' }
});
app.use('/api/', apiLimiter);

// Public routes
app.post('/api/login', async (req, res) => {
  try {
    const { email } = req.body || {};
    const id = uuidv4();
    const name = email ? email.split('@')[0] : 'Guest';
    const user = await findOrCreateUser(id, email || `${id}@guest.cognisys`, name);

    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET || 'cognisys-dev-secret',
      { expiresIn: process.env.JWT_ACCESS_EXPIRY || '24h' }
    );

    const refreshToken = jwt.sign(
      { sub: user.id, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET || 'cognisys-refresh-secret',
      { expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d' }
    );

    // Store refresh token in HTTP-only cookie ONLY — never in response body
    res.cookie('cognisys_refresh_token', refreshToken, REFRESH_COOKIE_OPTIONS);

    res.json({
      access_token: accessToken,
      // refresh_token intentionally omitted from body — HTTP-only cookie only
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan }
    });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Refresh endpoint reads token from HTTP-only cookie, not from request body
app.post('/api/refresh', (req, res) => {
  const refreshToken = req.cookies?.cognisys_refresh_token;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || 'cognisys-refresh-secret');

    const accessToken = jwt.sign(
      { sub: payload.sub },
      process.env.JWT_SECRET || 'cognisys-dev-secret',
      { expiresIn: process.env.JWT_ACCESS_EXPIRY || '24h' }
    );

    res.json({ access_token: accessToken });
  } catch (e) {
    res.clearCookie('cognisys_refresh_token', REFRESH_COOKIE_OPTIONS);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Logout — clear refresh cookie
app.post('/api/logout', (req, res) => {
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