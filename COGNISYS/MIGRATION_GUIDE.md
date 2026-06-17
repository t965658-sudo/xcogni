# PostgreSQL Migration Guide for CognisysAI

## Overview

This guide explains how to migrate CognisysAI from SQLite to PostgreSQL without modifying any business logic. The database layer has been abstracted to support both databases through a unified interface.

## Architecture

```
┌─────────────────────────────────────┐
│         Application Code            │
│  (routes, services, controllers)    │
├─────────────────────────────────────┤
│      Database Interface Layer       │
│         /database/index.js          │
├──────────────────┬──────────────────┤
│   SQLite Driver  │  PostgreSQL Driver│
│  /sqlite.js      │  /postgres.js     │
└──────────────────┴──────────────────┘
```

## Quick Start

### Option 1: Stay with SQLite (Default)

No configuration changes needed. The application will continue using SQLite.

```bash
npm start
```

### Option 2: Switch to PostgreSQL

1. **Set Environment Variables** in `.env`:

```env
# Database Configuration
DB_TYPE=postgres
DATABASE_URL=postgresql://username:password@localhost:5432/cognisys_db

# Optional: Connection pool settings (defaults shown)
# DB_POOL_MAX=20
# DB_POOL_IDLE_TIMEOUT=30000
# DB_POOL_CONNECTION_TIMEOUT=2000
```

2. **Start the Application**:

```bash
npm start
```

The database schema will be automatically created on first run.

## Environment Variables Reference

| Variable | Description | Default | Required For PostgreSQL |
|----------|-------------|---------|------------------------|
| `DB_TYPE` | Database driver (`sqlite` or `postgres`) | `sqlite` | ✅ Set to `postgres` |
| `DATABASE_URL` | PostgreSQL connection string | - | ✅ Yes |
| `SQLITE_DB_PATH` | Path to SQLite database file | `./data/cognisys.db` | ❌ No |
| `NODE_ENV` | Environment (`development`/`production`) | `development` | ❌ No |

## Database Schema Comparison

Both drivers create identical logical schemas:

### Tables

| Table | Description | Primary Key |
|-------|-------------|-------------|
| `users` | User accounts | `id` (TEXT/UUID) |
| `conversations` | Chat conversations | `id` (INTEGER, auto-increment) |
| `messages` | Chat messages | `id` (INTEGER, auto-increment) |
| `refresh_tokens` | JWT refresh tokens | `id` (INTEGER, auto-increment) |

### Indexes

- `idx_conversations_user` - Fast user conversation lookup
- `idx_conversations_updated` - Sort by last updated
- `idx_messages_conversation` - Fast message retrieval
- `idx_refresh_tokens_token` - Fast token validation

## Migration from Existing SQLite Data

If you have existing data in SQLite and want to migrate to PostgreSQL:

### Step 1: Export SQLite Data

```bash
cd /workspace/COGNISYS

# Create backup
cp data/cognisys.db data/cognisys.db.backup

# Export to JSON (using Node.js)
node -e "
const db = require('./database/sqlite');
const fs = require('fs');

(async () => {
  await db.initDB();
  
  const users = await db.all('SELECT * FROM users');
  const conversations = await db.all('SELECT * FROM conversations');
  const messages = await db.all('SELECT * FROM messages');
  const refreshTokens = await db.all('SELECT * FROM refresh_tokens');
  
  fs.writeFileSync('data/export.json', JSON.stringify({
    users,
    conversations,
    messages,
    refreshTokens,
    exportedAt: new Date().toISOString()
  }, null, 2));
  
  console.log('Export complete: data/export.json');
})();
"
```

### Step 2: Set Up PostgreSQL

```bash
# Install PostgreSQL (Ubuntu/Debian)
sudo apt-get install postgresql postgresql-contrib

# Or use Docker
docker run -d \
  --name cognisys-postgres \
  -e POSTGRES_USER=cognisys \
  -e POSTGRES_PASSWORD=your_secure_password \
  -e POSTGRES_DB=cognisys_db \
  -p 5432:5432 \
  postgres:15-alpine
```

### Step 3: Configure and Initialize

```env
# .env
DB_TYPE=postgres
DATABASE_URL=postgresql://cognisys:your_secure_password@localhost:5432/cognisys_db
```

```bash
# Initialize PostgreSQL schema
npm start
# Server will auto-create tables on first run
```

### Step 4: Import Data

```bash
node -e "
const db = require('./database');
const fs = require('fs');

(async () => {
  await db.initDB();
  
  const data = JSON.parse(fs.readFileSync('data/export.json', 'utf8'));
  
  // Import users
  for (const user of data.users) {
    await db.run(
      'INSERT INTO users (id, email, name, plan, created_at, updated_at) VALUES (\$1, \$2, \$3, \$4, \$5, \$6) ON CONFLICT (id) DO NOTHING',
      [user.id, user.email, user.name, user.plan, user.created_at, user.updated_at]
    );
  }
  
  // Import conversations (need to reset sequence)
  for (const conv of data.conversations) {
    await db.run(
      'INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (\$1, \$2, \$3, \$4, \$5) ON CONFLICT (id) DO NOTHING',
      [conv.id, conv.user_id, conv.title, conv.created_at, conv.updated_at]
    );
  }
  
  // Update sequence
  const maxConvId = Math.max(...data.conversations.map(c => c.id), 0);
  await db.run('SELECT setval(\'conversations_id_seq\', \$1, true)', [maxConvId]);
  
  // Import messages
  for (const msg of data.messages) {
    await db.run(
      'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (\$1, \$2, \$3, \$4, \$5) ON CONFLICT (id) DO NOTHING',
      [msg.id, msg.conversation_id, msg.role, msg.content, msg.created_at]
    );
  }
  
  const maxMsgId = Math.max(...data.messages.map(m => m.id), 0);
  await db.run('SELECT setval(\'messages_id_seq\', \$1, true)', [maxMsgId]);
  
  // Import refresh tokens
  for (const token of data.refreshTokens) {
    await db.run(
      'INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at) VALUES (\$1, \$2, \$3, \$4, \$5) ON CONFLICT (id) DO NOTHING',
      [token.id, token.user_id, token.token, token.expires_at, token.created_at]
    );
  }
  
  console.log('Migration complete!');
  process.exit(0);
})();
"
```

### Step 5: Verify and Switch Traffic

1. Test the application with PostgreSQL:
   ```bash
   npm start
   ```

2. Verify data integrity by checking conversations and messages.

3. Once verified, update production configuration.

## Development vs Production

### Development (SQLite)

```env
DB_TYPE=sqlite
SQLITE_DB_PATH=./data/cognisys-dev.db
NODE_ENV=development
```

**Benefits:**
- No external dependencies
- Fast local development
- Easy to reset (delete file)

### Production (PostgreSQL)

```env
DB_TYPE=postgres
DATABASE_URL=postgresql://user:pass@db.example.com:5432/cognisys_prod
NODE_ENV=production
```

**Benefits:**
- Scalability
- High availability
- Backup and replication
- Advanced monitoring

## Testing

Run tests with either database:

```bash
# Test with SQLite (default)
npm test

# Test with PostgreSQL
DB_TYPE=postgres DATABASE_URL=postgresql://test:test@localhost:5432/cognisys_test npm test
```

## Troubleshooting

### Connection Issues

```bash
# Test PostgreSQL connection
psql $DATABASE_URL -c "SELECT 1"

# Check if server is running
pg_isready -h localhost -p 5432
```

### Schema Not Created

Ensure `initDB()` is called before any database operations:

```javascript
const { initDB } = require('./database');
await initDB();
```

### Migration Errors

1. Check foreign key constraints are satisfied
2. Ensure sequences are properly set after importing
3. Verify timezone settings match between SQLite and PostgreSQL

## Performance Considerations

### Connection Pooling

PostgreSQL driver uses `pg.Pool` with these defaults:

```javascript
{
  max: 20,                    // Max connections
  idleTimeoutMillis: 30000,   // Close idle after 30s
  connectionTimeoutMillis: 2000  // Connect timeout 2s
}
```

Adjust via environment variables if needed.

### Indexes

All critical indexes are created automatically. For high-traffic deployments, consider:

```sql
-- Additional index for message search (if needed)
CREATE INDEX idx_messages_content ON messages USING gin(to_tsvector('english', content));
```

## Rollback Procedure

To switch back to SQLite:

1. Stop the application
2. Change `.env`:
   ```env
   DB_TYPE=sqlite
   ```
3. Restart application

Your SQLite database will be untouched and ready to use.

## Support

For issues or questions:
- Check logs in `cognisysai-server.log`
- Review error logs in `cognisysai-server.err.log`
- Ensure all dependencies are installed: `npm install`

---

**Last Updated:** $(date)
**Version:** CognisysAI v2.0.0
