-- ============================================================
-- FarmIQ Poultry Management System — PostgreSQL Schema
-- Includes: Access Control, Farm Ops, Financial Transactions
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE user_role AS ENUM (
  'super_admin',      -- Full system access
  'farm_owner',       -- Full farm access, all finance
  'farm_manager',     -- Farm ops + view finance
  'finance_officer',  -- Finance only, no farm ops write
  'veterinarian',     -- Health records only
  'data_entry',       -- Add transactions/records only
  'viewer'            -- Read-only across assigned modules
);

CREATE TYPE bird_purpose AS ENUM ('layers', 'broilers', 'breeders', 'dual_purpose');
CREATE TYPE batch_status AS ENUM ('brooding', 'growing', 'laying', 'peak_lay', 'declining', 'sold', 'culled');
CREATE TYPE health_event_type AS ENUM ('vaccination', 'treatment', 'mortality', 'deworming', 'biosecurity', 'inspection', 'other');
CREATE TYPE severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE transaction_type AS ENUM ('income', 'expense');
CREATE TYPE transaction_category AS ENUM (
  'egg_sales', 'broiler_sales', 'day_old_chick_sales', 'manure_sales', 'other_income',
  'feed_purchase', 'chick_purchase', 'medication', 'vaccination_cost', 'labour',
  'utilities', 'equipment', 'transport', 'maintenance', 'loan_repayment', 'other_expense'
);
CREATE TYPE payment_method AS ENUM ('cash', 'mobile_money', 'bank_transfer', 'cheque', 'credit');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'flagged');
CREATE TYPE feed_type AS ENUM ('chick_starter', 'broiler_starter', 'broiler_finisher', 'layers_mash', 'layers_concentrate', 'grower_mash', 'custom');

-- ============================================================
-- ORGANIZATIONS / FARMS
-- ============================================================

CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(200) NOT NULL,
  slug          VARCHAR(100) UNIQUE NOT NULL,
  address       TEXT,
  region        VARCHAR(100),
  country       VARCHAR(100) DEFAULT 'Ghana',
  phone         VARCHAR(20),
  email         VARCHAR(150),
  currency      VARCHAR(10) DEFAULT 'GHS',
  logo_url      TEXT,
  settings      JSONB DEFAULT '{}',
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USERS & ACCESS CONTROL
-- ============================================================

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
  email           VARCHAR(200) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  full_name       VARCHAR(200) NOT NULL,
  phone           VARCHAR(20),
  role            user_role NOT NULL DEFAULT 'viewer',
  avatar_url      TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  email_verified  BOOLEAN DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Granular module permissions per user
CREATE TABLE user_permissions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  module      VARCHAR(50) NOT NULL,  -- 'flock', 'health', 'feed', 'transactions', 'reports', 'users'
  can_view    BOOLEAN DEFAULT FALSE,
  can_create  BOOLEAN DEFAULT FALSE,
  can_edit    BOOLEAN DEFAULT FALSE,
  can_delete  BOOLEAN DEFAULT FALSE,
  can_approve BOOLEAN DEFAULT FALSE,  -- for finance approvals
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, module)
);

-- Default permission templates per role
CREATE TABLE role_permission_templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role        user_role NOT NULL,
  module      VARCHAR(50) NOT NULL,
  can_view    BOOLEAN DEFAULT FALSE,
  can_create  BOOLEAN DEFAULT FALSE,
  can_edit    BOOLEAN DEFAULT FALSE,
  can_delete  BOOLEAN DEFAULT FALSE,
  can_approve BOOLEAN DEFAULT FALSE,
  UNIQUE(role, module)
);

-- Audit log for all sensitive actions
CREATE TABLE audit_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID REFERENCES organizations(id),
  user_id       UUID REFERENCES users(id),
  action        VARCHAR(100) NOT NULL,   -- e.g. 'create_transaction', 'approve_transaction'
  resource_type VARCHAR(100),            -- e.g. 'transaction', 'batch'
  resource_id   UUID,
  old_value     JSONB,
  new_value     JSONB,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions / refresh tokens
CREATE TABLE user_sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT UNIQUE NOT NULL,
  ip_address    INET,
  user_agent    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FARM INFRASTRUCTURE
-- ============================================================

CREATE TABLE pens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  capacity    INTEGER NOT NULL,
  pen_type    VARCHAR(50),  -- 'brooder', 'grower', 'layer_house', 'broiler_house'
  location    VARCHAR(200),
  notes       TEXT,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FLOCK MANAGEMENT
-- ============================================================

CREATE TABLE batches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
  batch_code      VARCHAR(50) UNIQUE NOT NULL,
  breed           VARCHAR(100) NOT NULL,
  purpose         bird_purpose NOT NULL,
  status          batch_status NOT NULL DEFAULT 'brooding',
  pen_id          UUID REFERENCES pens(id),
  initial_count   INTEGER NOT NULL,
  current_count   INTEGER NOT NULL,
  doc_date        DATE NOT NULL,  -- Day of chick arrival
  expected_sale_date DATE,
  supplier        VARCHAR(200),
  purchase_cost   NUMERIC(12,2),
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Daily flock counts / mortality tracking
CREATE TABLE daily_flock_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id),
  batch_id        UUID REFERENCES batches(id) ON DELETE CASCADE,
  record_date     DATE NOT NULL,
  opening_count   INTEGER NOT NULL,
  mortalities     INTEGER DEFAULT 0,
  culled          INTEGER DEFAULT 0,
  sold            INTEGER DEFAULT 0,
  closing_count   INTEGER NOT NULL,
  notes           TEXT,
  recorded_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(batch_id, record_date)
);

-- ============================================================
-- EGG PRODUCTION
-- ============================================================

CREATE TABLE egg_production_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id),
  batch_id        UUID REFERENCES batches(id) ON DELETE CASCADE,
  pen_id          UUID REFERENCES pens(id),
  record_date     DATE NOT NULL,
  eggs_collected  INTEGER NOT NULL DEFAULT 0,
  broken_eggs     INTEGER DEFAULT 0,
  saleable_eggs   INTEGER GENERATED ALWAYS AS (eggs_collected - broken_eggs) STORED,
  egg_type        VARCHAR(20) CHECK (egg_type IN ('jumbo','extra_large','large','medium','pullet')),
  laying_rate     NUMERIC(5,2),  -- percentage
  notes           TEXT,
  recorded_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(batch_id, record_date)
);

-- ============================================================
-- HEALTH RECORDS
-- ============================================================

CREATE TABLE health_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id),
  batch_id        UUID REFERENCES batches(id) ON DELETE CASCADE,
  pen_id          UUID REFERENCES pens(id),
  event_type      health_event_type NOT NULL,
  event_date      DATE NOT NULL,
  severity        severity DEFAULT 'low',
  diagnosis       VARCHAR(300),
  treatment       TEXT,
  medication_used VARCHAR(300),
  dosage          VARCHAR(100),
  birds_affected  INTEGER DEFAULT 0,
  birds_treated   INTEGER DEFAULT 0,
  birds_died      INTEGER DEFAULT 0,
  vet_name        VARCHAR(200),
  next_action     TEXT,
  next_action_date DATE,
  cost            NUMERIC(10,2) DEFAULT 0,
  status          VARCHAR(50) DEFAULT 'completed',  -- 'ongoing', 'completed', 'monitoring'
  notes           TEXT,
  recorded_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FEED & INVENTORY
-- ============================================================

CREATE TABLE feed_inventory (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id),
  feed_type       feed_type NOT NULL,
  brand           VARCHAR(100),
  current_stock_kg NUMERIC(10,2) DEFAULT 0,
  minimum_stock_kg NUMERIC(10,2) DEFAULT 500,  -- reorder threshold
  unit_cost_per_kg NUMERIC(8,2),
  supplier        VARCHAR(200),
  last_restocked  TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, feed_type)
);

CREATE TABLE feed_transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id),
  transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('purchase', 'usage')),
  feed_type       feed_type NOT NULL,
  batch_id        UUID REFERENCES batches(id),
  pen_id          UUID REFERENCES pens(id),
  quantity_kg     NUMERIC(10,2) NOT NULL,
  unit_cost       NUMERIC(8,2),
  total_cost      NUMERIC(12,2),
  supplier        VARCHAR(200),
  invoice_ref     VARCHAR(100),
  transaction_date DATE NOT NULL,
  notes           TEXT,
  recorded_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FINANCIAL TRANSACTIONS (with approval workflow)
-- ============================================================

CREATE TABLE transactions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_ref   VARCHAR(50) UNIQUE NOT NULL,
  type              transaction_type NOT NULL,
  category          transaction_category NOT NULL,
  amount            NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_method    payment_method DEFAULT 'cash',
  transaction_date  DATE NOT NULL,
  description       TEXT NOT NULL,
  batch_id          UUID REFERENCES batches(id),
  pen_id            UUID REFERENCES pens(id),
  counterparty_name VARCHAR(200),   -- buyer / supplier name
  counterparty_phone VARCHAR(20),
  invoice_number    VARCHAR(100),
  receipt_url       TEXT,
  approval_status   approval_status DEFAULT 'pending',
  approved_by       UUID REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  flagged_reason    TEXT,
  requires_approval BOOLEAN DEFAULT FALSE,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Transaction approval threshold configuration
CREATE TABLE finance_settings (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID REFERENCES organizations(id) UNIQUE,
  approval_threshold  NUMERIC(12,2) DEFAULT 500.00,  -- amounts above need approval
  auto_approve_roles  user_role[] DEFAULT ARRAY['farm_owner']::user_role[],
  fiscal_year_start   INTEGER DEFAULT 1,  -- month (1=Jan)
  tax_rate            NUMERIC(5,2) DEFAULT 0,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SALES RECORDS (egg & broiler)
-- ============================================================

CREATE TABLE sales_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id),
  transaction_id  UUID REFERENCES transactions(id),
  sale_type       VARCHAR(20) NOT NULL CHECK (sale_type IN ('eggs', 'broilers', 'layers', 'chicks', 'other')),
  sale_date       DATE NOT NULL,
  batch_id        UUID REFERENCES batches(id),
  quantity        NUMERIC(10,2) NOT NULL,  -- trays for eggs, birds for poultry
  unit            VARCHAR(20) NOT NULL,    -- 'tray', 'bird', 'kg', 'crate'
  unit_price      NUMERIC(10,2) NOT NULL,
  total_amount    NUMERIC(14,2) NOT NULL,
  buyer_name      VARCHAR(200),
  buyer_phone     VARCHAR(20),
  notes           TEXT,
  recorded_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- REPORTS / SNAPSHOTS
-- ============================================================

CREATE TABLE monthly_summaries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organizations(id),
  year            INTEGER NOT NULL,
  month           INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  total_income    NUMERIC(14,2) DEFAULT 0,
  total_expenses  NUMERIC(14,2) DEFAULT 0,
  net_profit      NUMERIC(14,2) DEFAULT 0,
  total_eggs      INTEGER DEFAULT 0,
  birds_sold      INTEGER DEFAULT 0,
  total_mortalities INTEGER DEFAULT 0,
  avg_laying_rate NUMERIC(5,2),
  feed_consumed_kg NUMERIC(10,2),
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, year, month)
);

-- ============================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================

CREATE INDEX idx_users_org ON users(org_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_batches_org ON batches(org_id);
CREATE INDEX idx_batches_pen ON batches(pen_id);
CREATE INDEX idx_transactions_org ON transactions(org_id);
CREATE INDEX idx_transactions_date ON transactions(transaction_date DESC);
CREATE INDEX idx_transactions_type ON transactions(type, category);
CREATE INDEX idx_transactions_approval ON transactions(approval_status) WHERE approval_status = 'pending';
CREATE INDEX idx_health_records_batch ON health_records(batch_id);
CREATE INDEX idx_egg_records_date ON egg_production_records(record_date DESC);
CREATE INDEX idx_feed_tx_org ON feed_transactions(org_id, transaction_date DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id, created_at DESC);

-- ============================================================
-- DEFAULT ROLE PERMISSION TEMPLATES
-- ============================================================

INSERT INTO role_permission_templates (role, module, can_view, can_create, can_edit, can_delete, can_approve) VALUES
-- super_admin: everything
('super_admin','flock',true,true,true,true,true),
('super_admin','health',true,true,true,true,true),
('super_admin','feed',true,true,true,true,true),
('super_admin','transactions',true,true,true,true,true),
('super_admin','reports',true,true,true,true,true),
('super_admin','users',true,true,true,true,true),
-- farm_owner: everything except user management (super_admin only)
('farm_owner','flock',true,true,true,true,false),
('farm_owner','health',true,true,true,true,false),
('farm_owner','feed',true,true,true,true,false),
('farm_owner','transactions',true,true,true,true,true),
('farm_owner','reports',true,true,false,false,false),
('farm_owner','users',true,true,true,false,false),
-- farm_manager: farm ops full, finance view only
('farm_manager','flock',true,true,true,false,false),
('farm_manager','health',true,true,true,false,false),
('farm_manager','feed',true,true,true,false,false),
('farm_manager','transactions',true,true,false,false,false),
('farm_manager','reports',true,false,false,false,false),
('farm_manager','users',false,false,false,false,false),
-- finance_officer: finance full, farm ops read only
('finance_officer','flock',true,false,false,false,false),
('finance_officer','health',false,false,false,false,false),
('finance_officer','feed',true,false,false,false,false),
('finance_officer','transactions',true,true,true,false,true),
('finance_officer','reports',true,true,false,false,false),
('finance_officer','users',false,false,false,false,false),
-- veterinarian: health full, flock view
('veterinarian','flock',true,false,false,false,false),
('veterinarian','health',true,true,true,false,false),
('veterinarian','feed',false,false,false,false,false),
('veterinarian','transactions',false,false,false,false,false),
('veterinarian','reports',false,false,false,false,false),
('veterinarian','users',false,false,false,false,false),
-- data_entry: add only, no delete/approve
('data_entry','flock',true,true,false,false,false),
('data_entry','health',true,true,false,false,false),
('data_entry','feed',true,true,false,false,false),
('data_entry','transactions',true,true,false,false,false),
('data_entry','reports',true,false,false,false,false),
('data_entry','users',false,false,false,false,false),
-- viewer: read only, no finance
('viewer','flock',true,false,false,false,false),
('viewer','health',true,false,false,false,false),
('viewer','feed',true,false,false,false,false),
('viewer','transactions',false,false,false,false,false),
('viewer','reports',false,false,false,false,false),
('viewer','users',false,false,false,false,false);

-- ============================================================
-- TRIGGER: auto-update updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_updated BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_batches_updated BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_transactions_updated BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_health_updated BEFORE UPDATE ON health_records FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- TRIGGER: auto-generate transaction_ref
-- ============================================================

CREATE OR REPLACE FUNCTION generate_transaction_ref()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.transaction_ref IS NULL THEN
    NEW.transaction_ref := 'TXN-' || TO_CHAR(NOW(), 'YYYYMM') || '-' || UPPER(SUBSTRING(uuid_generate_v4()::text, 1, 6));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_transaction_ref BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION generate_transaction_ref();

-- ============================================================
-- TRIGGER: update feed_inventory on feed_transaction
-- ============================================================

CREATE OR REPLACE FUNCTION update_feed_stock()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.transaction_type = 'purchase' THEN
    INSERT INTO feed_inventory (org_id, feed_type, current_stock_kg, unit_cost_per_kg, last_restocked)
    VALUES (NEW.org_id, NEW.feed_type, NEW.quantity_kg, NEW.unit_cost, NOW())
    ON CONFLICT (org_id, feed_type) DO UPDATE
    SET current_stock_kg = feed_inventory.current_stock_kg + NEW.quantity_kg,
        unit_cost_per_kg = NEW.unit_cost,
        last_restocked = NOW(),
        updated_at = NOW();
  ELSIF NEW.transaction_type = 'usage' THEN
    UPDATE feed_inventory
    SET current_stock_kg = GREATEST(0, current_stock_kg - NEW.quantity_kg),
        updated_at = NOW()
    WHERE org_id = NEW.org_id AND feed_type = NEW.feed_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_feed_stock AFTER INSERT ON feed_transactions FOR EACH ROW EXECUTE FUNCTION update_feed_stock();
