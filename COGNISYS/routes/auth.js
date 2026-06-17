const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/me', async (req, res) => {
  try {
    const user = await db.getUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, name: user.name, email: user.email, plan: user.plan });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    await db.deleteUserRefreshTokens(req.user.id);
    res.json({ message: 'Logged out' });
  } catch (e) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

module.exports = router;