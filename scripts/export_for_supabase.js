// Exports local DB data as INSERT statements you can paste into Supabase SQL Editor
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

const local = new Pool({
  connectionString: 'postgresql://postgres:farmiq2024@localhost:5432/farmiq',
  ssl: false,
});

function escape(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return val;
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') {
    const str = JSON.stringify(val).replace(/'/g, "''");
    return `'${str}'`;
  }
  const str = String(val).replace(/'/g, "''");
  return `'${str}'`;
}

const GENERATED_COLUMNS = {
  egg_production_records: ['saleable_eggs'],
  feed_transactions: ['bags_count', 'kg_per_bag'],
};

async function exportTable(client, table, out) {
  const { rows } = await client.query(`SELECT * FROM ${table} ORDER BY created_at ASC NULLS LAST`);
  if (rows.length === 0) {
    out.push(`-- ${table}: no data`);
    return;
  }
  const skip = new Set(GENERATED_COLUMNS[table] || []);
  out.push(`\n-- ${table} (${rows.length} rows)`);
  for (const row of rows) {
    const entries = Object.entries(row).filter(([col]) => !skip.has(col));
    const cols = entries.map(([col]) => col).join(', ');
    const vals = entries.map(([, val]) => escape(val)).join(', ');
    out.push(`INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING;`);
  }
}

async function main() {
  const client = await local.connect();
  const out = [
    '-- FarmIQ data migration — paste into Supabase SQL Editor',
    '-- Generated: ' + new Date().toISOString(),
  ];

  // Order matters — respect foreign key dependencies
  const tables = [
    'organizations',
    'users',
    'user_permissions',
    'role_permission_templates',
    'user_sessions',
    'audit_logs',
    'pens',
    'batches',
    'daily_flock_records',
    'egg_production_records',
    'health_records',
    'feed_inventory',
    'feed_transactions',
    'finance_settings',
    'transactions',
    'sales_records',
    'monthly_summaries',
  ];

  for (const table of tables) {
    try {
      await exportTable(client, table, out);
    } catch (e) {
      out.push(`-- SKIPPED ${table}: ${e.message}`);
    }
  }


  const sql = out.join('\n');
  fs.writeFileSync('scripts/supabase_import.sql', sql);
  console.log('Done! Open scripts/supabase_import.sql and paste it into Supabase SQL Editor.');
  client.release();
  await local.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
