/**
 * Database Interface Factory
 * Returns the appropriate database driver based on environment configuration
 * 
 * Usage: const db = require('../database');
 * 
 * Environment Variables:
 * - DB_TYPE: 'sqlite' or 'postgres' (default: 'sqlite')
 * - DATABASE_URL: PostgreSQL connection string (required if DB_TYPE='postgres')
 * - SQLITE_DB_PATH: Path to SQLite database file (optional, default: ./data/cognisys.db)
 */

const path = require('path');

const DB_TYPE = process.env.DB_TYPE || 'sqlite';

let dbInstance = null;

function getDatabase() {
  if (dbInstance) {
    return dbInstance;
  }

  switch (DB_TYPE.toLowerCase()) {
    case 'postgres':
    case 'postgresql':
      if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
      }
      dbInstance = require('./postgres');
      console.log(`[Database] Using PostgreSQL driver`);
      break;
    
    case 'sqlite':
    default:
      const sqlitePath = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'cognisys.db');
      process.env.SQLITE_DB_PATH = sqlitePath;
      dbInstance = require('./sqlite');
      console.log(`[Database] Using SQLite driver at ${sqlitePath}`);
      break;
  }

  return dbInstance;
}

// Export all database functions directly for backward compatibility
const db = getDatabase();

module.exports = {
  // Core functions
  initDB: db.initDB,
  run: db.run,
  get: db.get,
  all: db.all,
  
  // User functions
  findOrCreateUser: db.findOrCreateUser,
  getUser: db.getUser,
  
  // Conversation functions
  createConversation: db.createConversation,
  getConversations: db.getConversations,
  getConversation: db.getConversation,
  updateConversationTitle: db.updateConversationTitle,
  deleteConversation: db.deleteConversation,
  
  // Message functions
  createMessage: db.createMessage,
  getMessages: db.getMessages,
  updateMessage: db.updateMessage,
  
  // Refresh token functions
  saveRefreshToken: db.saveRefreshToken,
  getRefreshToken: db.getRefreshToken,
  deleteRefreshToken: db.deleteRefreshToken,
  deleteUserRefreshTokens: db.deleteUserRefreshTokens,
  
  // Utility
  getDatabase,
  DB_TYPE
};
