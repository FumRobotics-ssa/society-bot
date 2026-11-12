import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// The same prepared statements and atomic batches used by D1 run on a VPS.
export function createDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const native = new DatabaseSync(path);
  native.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') native.exec('PRAGMA journal_mode = WAL;');
  class Statement {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { return new Statement(this.sql, args); }
    async first(column) {
      const row = native.prepare(this.sql).get(...this.args) ?? null;
      return column && row ? row[column] : row;
    }
    async all() { return { results: native.prepare(this.sql).all(...this.args), success: true }; }
    execute() {
      const stmt = native.prepare(this.sql);
      if (stmt.columns().length) {
        const rows = stmt.all(...this.args);
        return { success: true, results: rows, meta: { changes: Number(native.prepare('SELECT changes() AS n').get().n) } };
      }
      const info = stmt.run(...this.args);
      return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    async run() { return this.execute(); }
  }
  return {
    prepare: sql => new Statement(sql),
    async batch(statements) {
      native.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(stmt => stmt.execute());
        native.exec('COMMIT');
        return results;
      } catch (error) { native.exec('ROLLBACK'); throw error; }
    },
    exec: sql => native.exec(sql),
    close: () => native.close(),
    native,
  };
}
