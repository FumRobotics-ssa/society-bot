import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/sqlite.js';
import { Store } from '../src/store.js';
import { exportBackup, runBackup } from '../src/backup.js';

const schema = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort().map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');
test('legacy conversion keeps approved ticket and profile without changing source or trusting old roles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robotics-migration-'));
  const source = join(dir, 'old.sqlite'), output = join(dir, 'new.sql');
  const old = createDatabase(source);
  old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,first_name TEXT,last_name TEXT,phone_number TEXT,role TEXT,is_student INTEGER,student_number TEXT);
    CREATE TABLE places(id INTEGER PRIMARY KEY,name TEXT,address TEXT,capacity INTEGER);
    CREATE TABLE events(id INTEGER PRIMARY KEY,name TEXT,description TEXT,is_paid INTEGER,max_ticket_batch INTEGER,place_id INTEGER,is_active INTEGER);
    CREATE TABLE tickets(id INTEGER PRIMARY KEY,purchase_time TEXT,status TEXT,user_id INTEGER,event_id INTEGER);
    INSERT INTO users VALUES(1,'علی','محمدی','09123456789','mod',1,'123456');
    INSERT INTO places VALUES(1,'سالن','دانشگاه',10);
    INSERT INTO events VALUES(1,'رویداد','',1,2,1,1);
    INSERT INTO tickets VALUES(1234,'2025-01-01T00:00:00Z','completed',1,1);`);
  old.close(); const before = readFileSync(source);
  const result = spawnSync('python', [fileURLToPath(new URL('../scripts/import-legacy.py', import.meta.url)), source, output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(readFileSync(source), before);
  const target = createDatabase(); target.exec(schema); target.exec(readFileSync(output, 'utf8'));
  assert.equal(target.native.prepare('SELECT legacy_code FROM tickets').get().legacy_code, '1234');
  assert.equal(target.native.prepare('SELECT status FROM orders').get().status, 'approved');
  assert.equal(target.native.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 0);
  assert.equal(target.native.prepare('SELECT active FROM events').get().active, 0); target.close(); rmSync(dir, { recursive: true });
});
test('random-code migration replaces sequential values while preserving ticket links', () => {
  const priorSchema = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql') && name < '0005_randomize_ticket_checkin_codes.sql').sort().map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');
  const db = createDatabase(); db.exec(priorSchema);
  db.exec(`INSERT INTO users(id,first_name) VALUES(1,'علی');
    INSERT INTO events(name,capacity,max_per_user) VALUES('رویداد',2,2);
    INSERT INTO orders(id,request_key,user_id,event_id,quantity,status) VALUES('order','key',1,1,2,'approved');
    INSERT INTO tickets(id,token,checkin_code,order_id) VALUES('t1','${'a'.repeat(64)}','00000001','order'),('t2','${'b'.repeat(64)}','00000002','order');`);
  const before = db.native.prepare('SELECT id,token FROM tickets ORDER BY id').all().map(({ id, token }) => ({ id, token }));
  db.exec(readFileSync(new URL('../migrations/0005_randomize_ticket_checkin_codes.sql', import.meta.url), 'utf8'));
  const after = db.native.prepare('SELECT id,token,checkin_code FROM tickets ORDER BY id').all();
  assert.deepEqual(after.map(({ id, token }) => ({ id, token })), before);
  assert.ok(after.every(ticket => /^[1-9][0-9]{7}$/.test(ticket.checkin_code)));
  assert.equal(new Set(after.map(ticket => ticket.checkin_code)).size, 2);
  assert.ok(after.every(ticket => !['00000001', '00000002'].includes(ticket.checkin_code)));
  db.close();
});

test('differentiated pricing migration preserves old events and orders at their existing fixed price', () => {
  const priorSchema = readdirSync(new URL('../migrations/', import.meta.url))
    .filter(name => name.endsWith('.sql') && name < '0006_differentiated_event_pricing.sql')
    .sort().map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');
  const db = createDatabase(); db.exec(priorSchema);
  db.exec(`INSERT INTO users(id,first_name,phone) VALUES(1,'علی','09123456789');
    INSERT INTO events(name,capacity,max_per_user,is_paid,price) VALUES('رویداد قدیمی',3,2,1,125000);
    INSERT INTO orders(id,request_key,user_id,event_id,quantity,unit_price,status) VALUES('old-order','old-key',1,1,1,125000,'approved');`);
  db.exec(readFileSync(new URL('../migrations/0006_differentiated_event_pricing.sql', import.meta.url), 'utf8'));
  const migratedEvent = db.native.prepare('SELECT pricing_mode,fum_student_price,is_paid,price FROM events WHERE id=1').get();
  assert.equal(migratedEvent.pricing_mode, 'fixed');
  assert.equal(migratedEvent.fum_student_price, 0);
  assert.equal(migratedEvent.is_paid, 1);
  assert.equal(migratedEvent.price, 125000);
  const migratedOrder = db.native.prepare('SELECT pricing_group,unit_price,status FROM orders WHERE id=?').get('old-order');
  assert.equal(migratedOrder.pricing_group, 'fixed');
  assert.equal(migratedOrder.unit_price, 125000);
  assert.equal(migratedOrder.status, 'approved');
  db.close();
});

test('JSON backup restore preserves ticket token and excludes sessions and admin rights by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robotics-restore-')); const source = join(dir, 'backup.json'), output = join(dir, 'restore.sql');
  const db = createDatabase(); db.exec(schema); const store = new Store(db);
  await store.upsertUser({ id: 1, phone: '09123456789' }); await store.setAdmin(1, 'admin');
  const endsAt = '2026-12-03T16:00:00+03:30';
  const event = await store.saveEvent({ name: 'رویداد', capacity: 2, starts_at: '2026-12-03T14:00:00+03:30', ends_at: endsAt });
  const order = await store.reserve(1, event.id, 1, 'x');
  const snapshot = await exportBackup({ DB: db });
  assert.equal(JSON.parse(snapshot).format, 'robotics-society-json');
  writeFileSync(source, snapshot);
  const result = spawnSync('python', [fileURLToPath(new URL('../scripts/restore-backup.py', import.meta.url)), source, output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const target = createDatabase(); target.exec(schema); target.exec(readFileSync(output, 'utf8'));
  assert.equal(target.native.prepare('SELECT token FROM tickets').get().token, order.tickets[0].token);
  assert.equal(target.native.prepare('SELECT ends_at FROM events').get().ends_at, endsAt);
  assert.match(target.native.prepare('SELECT checkin_code FROM tickets').get().checkin_code, /^[1-9][0-9]{7}$/);
  assert.equal(target.native.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 0);
  const oldSnapshot = JSON.parse(snapshot);
  delete oldSnapshot.tables.events[0].pricing_mode;
  delete oldSnapshot.tables.events[0].fum_student_price;
  delete oldSnapshot.tables.events[0].ends_at;
  delete oldSnapshot.tables.orders[0].pricing_group;
  const oldSource = join(dir, 'pre-pricing-backup.json'), oldOutput = join(dir, 'pre-pricing-restore.sql');
  writeFileSync(oldSource, JSON.stringify(oldSnapshot));
  const oldRestore = spawnSync('python', [fileURLToPath(new URL('../scripts/restore-backup.py', import.meta.url)), oldSource, oldOutput], { encoding: 'utf8' });
  assert.equal(oldRestore.status, 0, oldRestore.stderr);
  const oldTarget = createDatabase(); oldTarget.exec(schema); oldTarget.exec(readFileSync(oldOutput, 'utf8'));
  assert.equal(oldTarget.native.prepare('SELECT pricing_mode FROM events').get().pricing_mode, 'fixed');
  assert.equal(oldTarget.native.prepare('SELECT ends_at FROM events').get().ends_at, '');
  assert.equal(oldTarget.native.prepare('SELECT pricing_group FROM orders').get().pricing_group, 'fixed');
  const legacySource = join(dir, 'legacy.json'), legacyOutput = join(dir, 'legacy.sql');
  const legacySnapshot = JSON.parse(snapshot);
  legacySnapshot.format = 'siahe-json';
  legacySnapshot.tables.tickets[0].checkin_code = '00000001';
  writeFileSync(legacySource, JSON.stringify(legacySnapshot));
  const legacyResult = spawnSync('python', [fileURLToPath(new URL('../scripts/restore-backup.py', import.meta.url)), legacySource, legacyOutput], { encoding: 'utf8' });
  assert.equal(legacyResult.status, 0, legacyResult.stderr);
  const legacyTarget = createDatabase(); legacyTarget.exec(schema); legacyTarget.exec(readFileSync(legacyOutput, 'utf8'));
  assert.equal(legacyTarget.native.prepare('SELECT token FROM tickets').get().token, order.tickets[0].token);
  assert.match(legacyTarget.native.prepare('SELECT checkin_code FROM tickets').get().checkin_code, /^[1-9][0-9]{7}$/);
  db.close(); target.close(); oldTarget.close(); legacyTarget.close(); rmSync(dir, { recursive: true });
});
test('questions are recoverable from private backups and excluded from Telegram backup documents', async t => {
  const db = createDatabase(); db.exec(schema);
  const restored = createDatabase(); restored.exec(schema);
  t.after(() => { db.close(); restored.close(); });
  const directory = mkdtempSync(join(tmpdir(), 'robotics-questions-restore-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(db);
  await store.upsertUser({ id: 1, phone: '09123456789' });
  const event = await store.saveEvent({ name: 'نشست', capacity: 2 });
  await store.reserve(1, event.id, 1, 'booking');
  await store.saveEventQuestionSettings(event.id, { enabled: true, closes_at: Math.floor(Date.now() / 1000) + 3600, max_questions: 2 });
  await store.submitEventQuestion(event.id, 1, 'متن محرمانهٔ پرسش', 'question-key');
  const [question] = await store.listEventQuestions(event.id);
  await store.selectEventQuestion(event.id, question.id, { selected: true, topic: 'صنعت' });

  let privateBackup;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    privateBackup = options.body;
    return new Response(null, { status: 200 });
  });
  const env = { DB: db, BACKUP_CHAT: '-100456', S3_BUCKET: 'private', S3_ENDPOINT: 'https://backup.example.test',
    S3_ACCESS_KEY_ID: 'fake-id', S3_SECRET_ACCESS_KEY: 'fake-secret' };
  await runBackup(env, 'questions-backup');
  assert.match(privateBackup, /متن محرمانهٔ پرسش/);
  const telegram = await store.one("SELECT payload FROM outbox WHERE method='sendDocument'");
  const telegramBackup = JSON.parse(JSON.parse(telegram.payload)._documentText);
  assert.equal('event_questions' in telegramBackup.tables, false);
  assert.equal('event_question_settings' in telegramBackup.tables, false);

  const source = join(directory, 'backup.json'), output = join(directory, 'restore.sql');
  const preLimitBackup = JSON.parse(privateBackup);
  assert.equal(preLimitBackup.tables.event_question_settings[0].max_questions, 2);
  delete preLimitBackup.tables.event_question_settings[0].max_questions;
  writeFileSync(source, JSON.stringify(preLimitBackup));
  const result = spawnSync('python', [fileURLToPath(new URL('../scripts/restore-backup.py', import.meta.url)), source, output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  restored.exec(readFileSync(output, 'utf8'));
  const restoredStore = new Store(restored);
  assert.equal((await restoredStore.getEventQuestionSettings(event.id)).enabled, 1);
  assert.equal((await restoredStore.getEventQuestionSettings(event.id)).max_questions, 3);
  assert.deepEqual((await restoredStore.selectedEventQuestions(event.id)).map(row => ({ ...row })),
    [{ question: 'متن محرمانهٔ پرسش', topic: 'صنعت' }]);
});

test('daily backup filename has only project name and date', async () => {
  const db = createDatabase(); db.exec(schema);
  await runBackup({ DB: db, BACKUP_CHAT: '-100456' }, 'manual:2026-11-14', new Date('2026-11-13T21:16:00Z'));
  const rows = await db.prepare("SELECT payload FROM outbox WHERE method='sendDocument'").all();
  assert.equal(rows.results.length, 1);
  assert.equal(JSON.parse(rows.results[0].payload).filename, 'robotics-society-2026-11-14.json');
  db.close();
});
