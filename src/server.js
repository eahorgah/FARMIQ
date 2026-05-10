require('dotenv').config();
const app = require('./app');
const { pool } = require('./config/db');

const PORT = process.env.PORT || 4000;

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});

async function runMigrations() {
  try {
    await pool.query(`
      ALTER TABLE egg_production_records
        ADD COLUMN IF NOT EXISTS egg_type VARCHAR(20)
        CHECK (egg_type IN ('jumbo','extra_large','large','medium','pullet'))
    `);
    console.log('Migrations OK');
  } catch (err) {
    console.error('Migration error:', err.message);
  }
}

runMigrations().then(() => {
  app.listen(PORT, () => {
    console.log(`FarmIQ API running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
});
