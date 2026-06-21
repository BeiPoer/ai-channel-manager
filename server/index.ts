import { createDatabase } from './db.js';
import { loadConfig } from './config.js';
import { createApp } from './routes.js';
import { Scheduler } from './scheduler.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3642);
const config = loadConfig();
const db = createDatabase();
const app = createApp(db, config);
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
