const sqlite3 = require('sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'cognisys.db');
let db;

function initDB() {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) { reject(err); return; }
      
      db.run('PRAGMA journal_mode=WAL');
      db.run('PRAGMA foreign_keys=ON');
      
      db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE,
          name TEXT DEFAULT '',
          plan TEXT DEFAULT 'free',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          title TEXT DEFAULT 'New conversation',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS refresh_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          token TEXT UNIQUE NOT NULL,
          expires_at DATETIME NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)`);
        
        console.log('Database initialized successfully');
        resolve();
      });
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ─── Users ──────────────────────────────────
async function findOrCreateUser(id, email, name) {
  let user = await get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) {
    await run('INSERT INTO users (id, email, name) VALUES (?, ?, ?)', [id, email, name]);
    user = await get('SELECT * FROM users WHERE id = ?', [id]);
  }
  return user;
}

async function getUser(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

// ─── Conversations ──────────────────────────
async function createConversation(userId, title) {
  const result = await run(
    'INSERT INTO conversations (user_id, title) VALUES (?, ?)',
    [userId, title]
  );
  return get('SELECT * FROM conversations WHERE id = ?', [result.id]);
}

async function getConversations(userId) {
  return all(
    'SELECT c.*, (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC',
    [userId]
  );
}

async function getConversation(id, userId) {
  return get('SELECT * FROM conversations WHERE id = ? AND user_id = ?', [id, userId]);
}

async function updateConversationTitle(id, userId, title) {
  await run('UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [title, id, userId]);
}

async function deleteConversation(id, userId) {
  await run('DELETE FROM conversations WHERE id = ? AND user_id = ?', [id, userId]);
}

// ─── Messages ───────────────────────────────
async function createMessage(conversationId, role, content) {
  const result = await run(
    'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
    [conversationId, role, content]
  );
  await run('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conversationId]);
  return get('SELECT * FROM messages WHERE id = ?', [result.id]);
}

async function getMessages(conversationId) {
  return all(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [conversationId]
  );
}

async function updateMessage(id, content) {
  await run('UPDATE messages SET content = ? WHERE id = ?', [content, id]);
  return get('SELECT * FROM messages WHERE id = ?', [id]);
}

// ─── Refresh Tokens ─────────────────────────
async function saveRefreshToken(userId, token, expiresAt) {
  await run(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
    [userId, token, expiresAt]
  );
}

async function getRefreshToken(token) {
  return get('SELECT * FROM refresh_tokens WHERE token = ? AND expires_at > datetime("now")', [token]);
}

async function deleteRefreshToken(token) {
  await run('DELETE FROM refresh_tokens WHERE token = ?', [token]);
}

async function deleteUserRefreshTokens(userId) {
  await run('DELETE FROM refresh_tokens WHERE user_id = ?', [userId]);
}

module.exports = {
  initDB, run, get, all,
  findOrCreateUser, getUser,
  createConversation, getConversations, getConversation, updateConversationTitle, deleteConversation,
  createMessage, getMessages, updateMessage,
  saveRefreshToken, getRefreshToken, deleteRefreshToken, deleteUserRefreshTokens
};