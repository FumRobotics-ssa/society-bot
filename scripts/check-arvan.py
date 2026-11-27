import argparse
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


def unit_log(unit, since, pattern):
    result = subprocess.run(['journalctl', '-u', unit, '--since', since,
                             '--grep', pattern, '--output', 'cat', '--no-pager'], capture_output=True, text=True)
    if result.returncode and result.stderr:
        result.check_returncode()
    return result.stdout.splitlines()


def read_queue(connection, table, statuses):
    placeholders = ','.join('?' for _ in statuses)
    row = connection.execute(
        f'SELECT count(*),COALESCE(unixepoch()-MIN(created_at),0) FROM {table} WHERE status IN ({placeholders})',
        statuses,
    ).fetchone()
    return dict(zip(('depth', 'oldest_seconds'), row))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('database', type=Path)
    args = parser.parse_args()
    app = 'robotics-society.service'
    receiver = 'robotics-telegram-receiver.service'
    units = {unit: subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0
             for unit in (app, receiver)}
    alerts = [f'{unit} inactive' for unit, active in units.items() if not active]
    receiver_healthy = bool(unit_log(receiver, '3 minutes ago', 'telegram_receiver_healthy')) if units[receiver] else False
    if units[receiver] and not receiver_healthy:
        alerts.append('No recent successful Telegram polling cycle')

    with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as database:
        inbox = read_queue(database, 'inbox', ('new', 'processing'))
        outbox = read_queue(database, 'outbox', ('pending', 'processing'))
        last_backup, = database.execute("SELECT MAX(sent_at) FROM outbox WHERE status='sent' AND dedupe_key GLOB 'backup-file:*'").fetchone()
    if inbox['depth'] >= 128 or inbox['oldest_seconds'] >= 120:
        alerts.append('Telegram inbox backlog')
    if outbox['depth'] >= 512 or outbox['oldest_seconds'] >= 180:
        alerts.append('Telegram outbox backlog')
    backup_age = int(time.time()) - last_backup if last_backup else None
    if backup_age is None or backup_age > 27 * 3600:
        alerts.append('No recent application backup')
    print(json.dumps({'units': units, 'receiver_healthy': receiver_healthy, 'inbox': inbox, 'outbox': outbox,
                      'app_backup_age_seconds': backup_age, 'alerts': alerts}))
    return int(bool(alerts))


if __name__ == '__main__':
    sys.exit(main())
