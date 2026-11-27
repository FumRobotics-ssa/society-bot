import { chmodSync, existsSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) throw new Error('Usage: node scripts/restore-sqlite.js <snapshot> <new-database>');
const sourcePath = resolve(sourceArg);
const targetPath = resolve(targetArg);
if ([targetPath, `${targetPath}-wal`, `${targetPath}-shm`, `${targetPath}-journal`].some(existsSync)) {
  throw new Error('Destination already exists. Use a new database in a separate volume.');
}
const temporary = mkdtempSync(join(dirname(targetPath), '.sqlite-restore-'));
const stagedPath = join(temporary, 'staged.sqlite');
let source;
let staged;
try {
  source = new DatabaseSync(sourcePath, { readOnly: true });
  await backup(source, stagedPath);
  staged = new DatabaseSync(stagedPath, { readOnly: true });
  const integrity = staged.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || staged.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('SQLite snapshot failed its integrity or foreign-key check');
  }
  const migrations = staged.prepare('SELECT count(*) AS applied FROM schema_migrations').get().applied;
  if (!migrations) throw new Error('Snapshot has no applied application migrations');
  staged.close();
  staged = undefined;
  chmodSync(stagedPath, 0o600);
  linkSync(stagedPath, targetPath);
  console.info(JSON.stringify({ restored: true, migrations }));
} finally {
  staged?.close();
  source?.close();
  rmSync(temporary, { recursive: true, force: true });
}
