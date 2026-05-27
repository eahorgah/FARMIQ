require('dotenv').config();
const app = require('./app');
const { pool } = require('./config/db');

const PORT = process.env.PORT || 4000;

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});

// Guard so migrations only run once per Lambda instance (warm re-use)
let _migrationsDone = false;

async function runMigrations() {
  if (_migrationsDone) return;
  _migrationsDone = true;
  const migrations = [
    `ALTER TABLE egg_production_records
       ADD COLUMN IF NOT EXISTS egg_type VARCHAR(20)
       CHECK (egg_type IN ('jumbo','extra_large','large','medium','pullet'))`,
    `ALTER TABLE sales_records
       ADD COLUMN IF NOT EXISTS egg_type VARCHAR(20)
       CHECK (egg_type IN ('jumbo','extra_large','large','medium','pullet'))`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); }
    catch (err) { console.error('Migration error:', err.message); }
  }
  console.log('Migrations OK');
}

// Run migrations on every environment (including Vercel/serverless)
// ADD COLUMN IF NOT EXISTS is idempotent — fast no-op once the column exists
runMigrations().catch(err => console.error('Startup migration error:', err.message));

// Only start the HTTP server when running locally (not on Vercel/serverless)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`FarmIQ API running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

// Export app so Vercel can use it as a serverless handler
module.exports = app;
