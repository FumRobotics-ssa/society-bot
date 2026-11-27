#!/usr/bin/env bash
set -euo pipefail
umask 077

database=${1:?SQLite database path required}
recipient_key=${2:?OpenPGP public key path required}
work_dir=$(mktemp -d /run/robotics-backup.XXXXXXXX)
trap 'rm -f "$work_dir/snapshot.sqlite"; GNUPGHOME="$work_dir/gpg" gpgconf --kill gpg-agent; rm -r -- "$work_dir/gpg"; rmdir "$work_dir"' EXIT
export GNUPGHOME="$work_dir/gpg"
mkdir -m 700 "$GNUPGHOME"

python3 - "$database" "$work_dir/snapshot.sqlite" <<'PY'
import sqlite3
import sys
from pathlib import Path

with sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True) as source:
    with sqlite3.connect(sys.argv[2]) as target:
        source.backup(target)
        target.execute('PRAGMA journal_mode=DELETE')
        if target.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise SystemExit('SQLite snapshot failed quick_check')
PY

gpg --batch --yes --trust-model always --recipient-file "$recipient_key" --output - --encrypt "$work_dir/snapshot.sqlite"
