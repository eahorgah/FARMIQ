// config/db.js
const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: isProduction ? 2 : 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Force search_path = public on every new connection so queries never
// accidentally resolve against Supabase's built-in auth schema
pool.on('connect', (client) => {
  client.query('SET search_path = public').catch(() => {});
});

pool.on('error', (err) => {
  console.error('Unexpected DB client error', err.message);
});

module.exports = { pool };
