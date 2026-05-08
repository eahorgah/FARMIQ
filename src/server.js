require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 4000;

// Keep the server alive — log unhandled rejections instead of crashing
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});

app.listen(PORT, () => {
  console.log(`FarmIQ API running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
