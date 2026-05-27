// middleware/errorHandler.js
const PG_ERRORS = {
  '23505': 'A record with that value already exists.',
  '23503': 'Referenced record does not exist.',
  '23502': 'A required field is missing.',
  '22P02': 'Invalid input format.',
};

const errorHandler = (err, req, res, next) => {
  // PostgreSQL errors — return 409/422 with a readable message
  if (err.code && PG_ERRORS[err.code]) {
    return res.status(err.code === '23505' ? 409 : 422).json({ error: PG_ERRORS[err.code] });
  }

  const status = err.status || 500;
  // Log full detail including PG error code and table/column hint
  console.error(`[${status}] ${req.method} ${req.path} — ${err.message}` +
    (err.code    ? ` | pg_code=${err.code}` : '') +
    (err.table   ? ` | table=${err.table}`  : '') +
    (err.column  ? ` | column=${err.column}` : '') +
    (err.detail  ? ` | detail=${err.detail}` : '')
  );
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  });
};
module.exports = { errorHandler };
