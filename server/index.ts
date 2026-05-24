import { createDatabase } from './db.js';
import { createApp } from './routes.js';
import { Scheduler } from './scheduler.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const db = createDatabase();
const app = createApp(db);
const scheduler = new Scheduler(db);

const server = app.listen(port, host, () => {
  scheduler.start();
  console.log(`AI channel manager listening on http://${host}:${port}`);
});

function shutdown() {
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

