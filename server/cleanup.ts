import { cleanupHistory, createDatabase } from './db.js';

const db = createDatabase();

try {
  db.exec('PRAGMA busy_timeout = 30000;');
  const result = cleanupHistory(db);
  db.exec('VACUUM;');
  console.log(`清理完成：删除 ${result.total} 条 7 天前的历史数据，数据库已压缩。`);
  console.table(result.deleted);
} finally {
  db.close();
}
