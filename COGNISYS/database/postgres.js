/**
 * PostgreSQL Database Driver for CognisysAI
 * Implements the same interface as sqlite.js for seamless database switching
 */

const { Pool } = require('pg');

let pool;
let initialized = false;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }
  return pool;
}

async function initDB() {
  if (initialized) return;
  
  const client = await getPool().connect();
  try {
    console.log('[PostgreSQL] Initializing database schema...');
    
    // Enable UUID extension
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        name TEXT DEFAULT '',
        plan TEXT DEFAULT 'free',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create conversations table with sequence
    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS conversations_id_seq
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY DEFAULT nextval('conversations_id_seq'),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT DEFAULT 'New conversation',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create messages table with sequence
    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS messages_id_seq
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY DEFAULT nextval('messages_id_seq'),
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create refresh_tokens table with sequence
    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS refresh_tokens_id_seq
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id INTEGER PRIMARY KEY DEFAULT nextval('refresh_tokens_id_seq'),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)`);
    
    console.log('[PostgreSQL] Database schema initialized successfully');
    initialized = true;
  } finally {
    client.release();
  }
}

async function run(sql, params = []) {
  const client = await getPool().connect();
  try {
    // Convert SQLite syntax to PostgreSQL where needed
    const adaptedSql = adaptSQL(sql);
    const result = await client.query(adaptedSql, params);
    return { 
      id: result.rows[0]?.id || null, 
      changes: result.rowCount,
      rows: result.rows
    };
  } finally {
    client.release();
  }
}

async function get(sql, params = []) {
  const client = await getPool().connect();
  try {
    const adaptedSql = adaptSQL(sql);
    const result = await client.query(adaptedSql, params);
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function all(sql, params = []) {
  const client = await getPool().connect();
  try {
    const adaptedSql = adaptSQL(sql);
    const result = await client.query(adaptedSql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Adapt SQLite SQL syntax to PostgreSQL
 */
function adaptSQL(sql) {
  let adapted = sql;
  
  // Replace datetime("now") with NOW()
  adapted = adapted.replace(/datetime\(["']now["']\)/gi, 'NOW()');
  
  // Replace CURRENT_TIMESTAMP with CURRENT_TIMESTAMP (already compatible)
  // Handle AUTOINCREMENT -> SERIAL (handled in table creation)
  
  return adapted;
}

// ─── Users ──────────────────────────────────
async function findOrCreateUser(id, email, name) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    
    let user = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    
    if (!user.rows[0]) {
      await client.query(
        'INSERT INTO users (id, email, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [id, email, name]
      );
      user = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    }
    
    await client.query('COMMIT');
    return user.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getUser(id) {
  return get('SELECT * FROM users WHERE id = $1', [id]);
}

// ─── Conversations ──────────────────────────
async function createConversation(userId, title) {
  const result = await run(
    'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *',
    [userId, title]
  );
  return result.rows[0];
}

async function getConversations(userId) {
  return all(`
    SELECT c.*, 
      (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message 
    FROM conversations c 
    WHERE c.user_id = $1 
    ORDER BY c.updated_at DESC
  `, [userId]);
}

async function getConversation(id, userId) {
  return get('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function updateConversationTitle(id, userId, title) {
  await run(
    'UPDATE conversations SET title = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3',
    [title, id, userId]
  );
}

async function deleteConversation(id, userId) {
  await run('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
}

// ─── Messages ───────────────────────────────
async function createMessage(conversationId, role, content) {
  const result = await run(
    'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING *',
    [conversationId, role, content]
  );
  await run('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [conversationId]);
  return result.rows[0];
}

async function getMessages(conversationId) {
  return all(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
    [conversationId]
  );
}

async function updateMessage(id, content) {
  await run('UPDATE messages SET content = $1 WHERE id = $2', [content, id]);
  return get('SELECT * FROM messages WHERE id = $1', [id]);
}

// ─── Refresh Tokens ─────────────────────────
async function saveRefreshToken(userId, token, expiresAt) {
  await run(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, token, expiresAt]
  );
}

async function getRefreshToken(token) {
  return get(
    'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
    [token]
  );
}

async function deleteRefreshToken(token) {
  await run('DELETE FROM refresh_tokens WHERE token = $1', [token]);
}

async function deleteUserRefreshTokens(userId) {
  await run('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
}

// Graceful shutdown
async function closeDB() {
  if (pool) {
    await pool.end();
    pool = null;
    initialized = false;
  }
}

module.exports = {
  initDB,
  run,
  get,
  all,
  findOrCreateUser,
  getUser,
  createConversation,
  getConversations,
  getConversation,
  updateConversationTitle,
  deleteConversation,
  createMessage,
  getMessages,
  updateMessage,
  saveRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  deleteUserRefreshTokens,
  closeDB,
  getPool
};
