'use strict';

const { createApp } = require('./app');

let app;
try {
  app = createApp();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}

function shutdown() {
  console.log('shutdown');
  const done = app ? app.close() : Promise.resolve();
  done.finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref?.();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => {
  console.error('unhandled', err && err.message ? err.message : err);
});

app.listen().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
