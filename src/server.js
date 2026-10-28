'use strict';

const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const app = createApp();

const server = app.listen(PORT, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │   FOLIO · Transaction Ledger             │');
  console.log(`  │   UI   → http://localhost:${PORT}`.padEnd(45) + '│');
  console.log(`  │   API  → http://localhost:${PORT}/api`.padEnd(45) + '│');
  console.log('  └──────────────────────────────────────────┘');
  console.log('');
});

function shutdown() {
  server.close(() => {
    app.locals.db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
