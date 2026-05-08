# FarmIQ — Backend Architecture & API Reference

## Stack
- **Runtime**: Node.js + Express.js
- **Database**: PostgreSQL 15+
- **Auth**: JWT (access + refresh tokens, 15min / 7day)
- **Security**: Helmet, CORS, rate limiting, bcrypt (cost 12)

---

## Access Control System

### Roles (hierarchy)

| Role | Description |
|------|-------------|
| `super_admin` | Full system access across all orgs |
| `farm_owner` | Full access to own org, can approve transactions |
| `farm_manager` | Farm ops (CRUD) + view finance |
| `finance_officer` | Finance (CRUD + approve) + view farm |
| `veterinarian` | Health records only |
| `data_entry` | Add records only (no delete/approve) |
| `viewer` | Read-only, no finance access |

### Permission Matrix per Module

| Role | flock | health | feed | transactions | reports | users |
|------|-------|--------|------|-------------|---------|-------|
| super_admin | VCEDA | VCEDA | VCEDA | VCEDA | VCEDA | VCEDA |
| farm_owner | VCED | VCED | VCED | VCEDA | VCR | VCE |
| farm_manager | VCE | VCE | VCE | VC | V | — |
| finance_officer | V | — | V | VCEA | VC | — |
| veterinarian | V | VCE | — | — | — | — |
| data_entry | VC | VC | VC | VC | V | — |
| viewer | V | V | V | — | — | — |

**V**=view, **C**=create, **E**=edit, **D**=delete, **A**=approve, **R**=read-only reports

### Transaction Approval Workflow

```
data_entry / farm_manager creates transaction
  → amount <= threshold (default ₵500)?
      YES → auto-approved (if creator is farm_owner → always auto-approved)
      NO  → status = 'pending'
              ↓
        finance_officer or farm_owner reviews
              ↓
        approve → status = 'approved' (counted in P&L)
        reject  → status = 'rejected' + reason stored
        flag    → status = 'flagged'  (escalate for investigation)
```

---

## API Endpoints

### Authentication
```
POST /api/auth/register        → create org + farm_owner
POST /api/auth/login           → returns accessToken + refreshToken
POST /api/auth/refresh         → rotate tokens
POST /api/auth/logout          → revoke refresh token
GET  /api/auth/me              → current user + permissions
```

### User Management (requires users:view/create/edit)
```
GET    /api/users              → list org users
POST   /api/users              → create user (seeds permissions from role template)
GET    /api/users/:id          → user detail + permissions
PATCH  /api/users/:id          → update role/status
PUT    /api/users/:id/permissions → override module permissions granularly
GET    /api/users/audit/logs   → activity audit trail (farm_owner+)
```

### Flock Management (requires flock permissions)
```
GET    /api/flock/batches      → list batches (filterable by status/purpose)
POST   /api/flock/batches      → create batch
PATCH  /api/flock/batches/:id  → update batch status/count
POST   /api/flock/daily-records → daily mortality/count entry
GET    /api/flock/pens         → list pens with occupancy
POST   /api/flock/pens         → create pen
```

### Health Records (requires health permissions)
```
GET    /api/health             → list records (filter: batch, event_type, severity)
POST   /api/health             → log health event
PATCH  /api/health/:id         → update status/treatment
```

### Feed & Inventory (requires feed permissions)
```
GET    /api/feed/inventory     → stock levels + low-stock alerts
POST   /api/feed/transactions  → log purchase or usage (auto-updates inventory)
GET    /api/feed/transactions  → feed transaction history
```

### Egg Production (requires flock permissions)
```
GET    /api/eggs               → records (filter: batch, date range)
POST   /api/eggs               → log daily collection (auto-calculates lay rate)
```

### Financial Transactions (requires transactions permissions)
```
GET    /api/transactions        → list (filter: type, category, status, date, batch)
GET    /api/transactions/summary → monthly totals by category
GET    /api/transactions/pending → items awaiting approval
POST   /api/transactions        → create (auto-approves or queues based on threshold)
PATCH  /api/transactions/:id    → edit (resets to pending if amount changed)
POST   /api/transactions/:id/approve → approve pending (finance_officer+)
POST   /api/transactions/:id/reject  → reject with reason
POST   /api/transactions/:id/flag    → flag for investigation
DELETE /api/transactions/:id    → delete (only non-approved; farm_owner+)
```

### Reports (requires reports:view)
```
GET    /api/reports/dashboard        → KPI summary (birds, eggs, revenue, profit)
GET    /api/reports/profit-loss      → P&L by category (year/month filter)
GET    /api/reports/production-summary → weekly egg production trend
```

---

## Database: Key Design Decisions

1. **Org isolation** — every table has `org_id`; all queries filter by it
2. **Soft approval** — transactions never deleted after approval; rejection preserves audit trail
3. **Granular permissions** — `user_permissions` table overrides role defaults per user
4. **Feed auto-sync** — trigger on `feed_transactions` auto-updates `feed_inventory`
5. **Audit log** — every sensitive mutation logged to `audit_logs` (non-blocking)
6. **Token rotation** — refresh tokens are single-use; rotated on each refresh call

---

## Environment Variables (.env)

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/farmiq
JWT_SECRET=your-32-char-secret-here
JWT_REFRESH_SECRET=your-32-char-refresh-secret
NODE_ENV=development
PORT=4000
ALLOWED_ORIGINS=http://localhost:3000
```

---

## Setup

```bash
npm install
psql -U postgres -c "CREATE DATABASE farmiq"
psql -U postgres -d farmiq -f docs/schema.sql
npm run dev
```
