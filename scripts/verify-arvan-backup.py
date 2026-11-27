import json
import sqlite3
import sys


with sqlite3.connect(':memory:') as database:
    database.deserialize(sys.stdin.buffer.read())
    if database.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise SystemExit('SQLite backup failed integrity_check')
    if database.execute('PRAGMA foreign_key_check').fetchone() is not None:
        raise SystemExit('SQLite backup contains an invalid foreign key')
    counts = {}
    for table in ('users', 'events', 'orders', 'tickets', 'support_tickets', 'event_questions'):
        (counts[table],) = database.execute(f'SELECT count(*) FROM {table}').fetchone()
    if not counts['users'] or not counts['events']:
        raise SystemExit('SQLite backup does not contain live data')
    print(json.dumps(counts))
