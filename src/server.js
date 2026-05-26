require('dotenv').config();
const app = require('./app');
const { pool } = require('./config/db');

const PORT = process.env.PORT || 4000;

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});

async function runMigrations() {
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

// Only start the HTTP server when running locally (not on Vercel/serverless)
if (process.env.VERCEL !== '1') {
  runMigrations().then(() => {
    app.listen(PORT, () => {
      console.log(`FarmIQ API running on http://localhost:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  });
}

// Export app so Vercel can use it as a serverless handler
module.exports = app;
