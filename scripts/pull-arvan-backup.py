import argparse
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('host', help='SSH admin user and host')
    parser.add_argument('key', type=Path, help='SSH identity file')
    parser.add_argument('backup_directory', type=Path)
    parser.add_argument('gpg_home', help='Local OpenPGP home directory')
    parser.add_argument('--database', required=True, help='Remote SQLite path')
    parser.add_argument('--remote-tools', default='/root/robotics-offsite')
    args = parser.parse_args()

    remote = ['sudo', '-n', 'bash', f'{args.remote_tools}/backup-arvan.sh', args.database, f'{args.remote_tools}/recipient.asc']
    ssh = ['ssh', '-n', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', str(args.key), args.host]
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    destination = args.backup_directory / f'arvan-{timestamp}.sqlite.gpg'
    verifier = Path(__file__).with_name('verify-arvan-backup.py')
    temporary = tempfile.NamedTemporaryFile(mode='wb', suffix='.partial', dir=args.backup_directory, delete=False)
    path = Path(temporary.name)
    try:
        with temporary as file:
            subprocess.run([*ssh, shlex.join(remote)], stdout=file, check=True, timeout=900)
        # Stdin keeps the encrypted file path independent of GPG's platform-specific path syntax.
        with path.open('rb') as encrypted:
            with subprocess.Popen(['gpg', '--batch', '--homedir', args.gpg_home, '--decrypt'],
                                  stdin=encrypted, stdout=subprocess.PIPE) as gpg:
                try:
                    subprocess.run([sys.executable, str(verifier)], stdin=gpg.stdout, check=True, timeout=90)
                    if gpg.wait(timeout=30):
                        raise RuntimeError('Backup decryption failed')
                finally:
                    if gpg.poll() is None:
                        gpg.kill()
        path.rename(destination)
        print(f'Verified encrypted backup saved ({destination.stat().st_size} bytes)')
    finally:
        path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
