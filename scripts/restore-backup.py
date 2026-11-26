#!/usr/bin/env python3
"""Validate a Robotics Society JSON snapshot and emit SQL for a NEW EMPTY database only.

No database is modified. Admin roles are excluded unless explicitly requested.
Sessions, tokens, inbox and outbox must never be restored as executable state.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import secrets
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("robotics_society_legacy_import", Path(__file__).with_name("import-legacy.py"))
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)

BASE_FIELDS = {
    "users": "id username first_name last_name phone profile_json is_deleted created_at updated_at",
    "places": "id name address capacity created_at map_url",
    "events": "id name description place_id capacity max_per_user is_paid price pricing_mode fum_student_price payment_instructions starts_at ends_at active archived created_at updated_at poster_url confirmation_message",
    "orders": "id request_key user_id event_id quantity unit_price pricing_group status expires_at receipt_file_id receipt_type receipt_key reviewed_by reviewed_at created_at updated_at",
    "tickets": "id token checkin_code legacy_code order_id checked_in_at checked_in_by created_at",
    "admins": "user_id role created_at",
    "audit_log": "id actor_id action target details_json created_at",
}
LEGACY_AUDIENCE_FIELDS = {
    "legacy_events": "id name description place_name place_address is_paid was_active imported_at",
    "legacy_event_participants": "legacy_event_id user_id ticket_count source_status",
}
HISTORICAL_FIELDS = {**BASE_FIELDS, **LEGACY_AUDIENCE_FIELDS}
QUESTION_FIELDS = {
    "event_question_settings": "event_id enabled closes_at max_questions",
    "event_questions": "id event_id user_id request_key question topic selected created_at",
}
FIELDS = {**HISTORICAL_FIELDS, **QUESTION_FIELDS}
OLD_TICKET_FIELDS = set(BASE_FIELDS["tickets"].split()) - {"checkin_code"}
OLD_EVENT_FIELDS = set(BASE_FIELDS["events"].split()) - {"pricing_mode", "fum_student_price", "poster_url"}
PRE_POSTER_EVENT_FIELDS = set(BASE_FIELDS["events"].split()) - {"poster_url"}
OLD_ORDER_FIELDS = set(BASE_FIELDS["orders"].split()) - {"pricing_group"}


def new_checkin_code(used):
    while True:
        code = str(10_000_000 + secrets.randbelow(90_000_000))
        if code not in used:
            return code


def validate_snapshot(snapshot, include_admins=False):
    if not isinstance(snapshot, dict) or snapshot.get("format") not in {"siahe-json", "robotics-society-json"} or snapshot.get("version") != 1:
        raise ValueError("Not a supported Robotics Society or legacy version 1 snapshot")
    if set(snapshot) - {"format", "version", "created_at", "tables"}:
        raise ValueError("Unknown top level snapshot fields")
    tables = snapshot.get("tables")
    if not isinstance(tables, dict) or set(tables) not in (set(BASE_FIELDS), set(HISTORICAL_FIELDS), set(FIELDS)):
        raise ValueError("Snapshot must contain exactly a supported set of backup tables")
    sql = legacy.empty_guard()
    checkin_codes = set()
    reserved_checkin_codes = {
        str(row.get("checkin_code")) for row in tables.get("tickets", [])
        if isinstance(row, dict)
        and set(row) == set(BASE_FIELDS["tickets"].split())
        and re.fullmatch(r"\d{8}", str(row.get("checkin_code", "")))
        and not str(row["checkin_code"]).startswith("0")
    }
    for table, columns in FIELDS.items():
        rows = tables.get(table, [])
        if not isinstance(rows, list):
            raise ValueError("Expected a list of rows in table " + table)
        for row in rows:
            if table == "places" and isinstance(row, dict) and "map_url" not in row:
                row = {**row, "map_url": ""}  # Accept backups made before the map-link migration.
            if table == "events" and isinstance(row, dict):
                if "pricing_mode" not in row:
                    row = {**row, "pricing_mode": "fixed"}
                if "fum_student_price" not in row:
                    row = {**row, "fum_student_price": 0}
                if "poster_url" not in row:
                    row = {**row, "poster_url": ""}
                if "confirmation_message" not in row:
                    row = {**row, "confirmation_message": ""}
                if "ends_at" not in row:
                    row = {**row, "ends_at": ""}
            if table == "event_question_settings" and isinstance(row, dict) and "max_questions" not in row:
                row = {**row, "max_questions": 3}
            if table == "orders" and isinstance(row, dict) and set(row) == OLD_ORDER_FIELDS:
                row = {**row, "pricing_group": "fixed"}
            if table == "tickets" and isinstance(row, dict) and set(row) == OLD_TICKET_FIELDS:
                row = {**row, "checkin_code": new_checkin_code(reserved_checkin_codes | checkin_codes)}
            elif table == "tickets" and isinstance(row, dict) and set(row) == set(BASE_FIELDS["tickets"].split()):
                old_code = str(row.get("checkin_code", ""))
                if re.fullmatch(r"\d{8}", old_code) and old_code.startswith("0"):
                    row = {**row, "checkin_code": new_checkin_code(reserved_checkin_codes | checkin_codes)}
            if not isinstance(row, dict) or set(row) != set(columns.split()):
                raise ValueError("Missing or unknown columns in table " + table)
            if table == "tickets":
                if not re.fullmatch(r"[0-9a-f]{64}", str(row["token"])):
                    raise ValueError("Snapshot contains a malformed ticket bearer token")
                if not re.fullmatch(r"\d{8}", str(row["checkin_code"])) or row["checkin_code"] in checkin_codes:
                    raise ValueError("Snapshot contains an invalid or duplicate numeric check-in code")
                checkin_codes.add(row["checkin_code"])
            if table == "admins" and row["role"] not in {"admin", "checkin"}:
                raise ValueError("Snapshot contains an unsupported administrator role")
            if table == "users":
                legacy.positive(row["id"], "user ID")
                if not isinstance(row["profile_json"], str) or not isinstance(json.loads(row["profile_json"]), dict):
                    raise ValueError("Invalid user profile JSON")
            # Validate excluded admin rows too, then deliberately omit their privileges.
            if table != "admins" or include_admins:
                sql.append(legacy.insert(table, {column: row[column] for column in columns.split()}))
    sql.append("DROP TABLE __robotics_empty_guard;")
    text = "\n".join(sql) + "\n"
    check = sqlite3.connect(":memory:")
    try:
        for migration in sorted((ROOT / "migrations").glob("*.sql")):
            check.executescript(migration.read_text(encoding="utf8"))
        check.executescript(text)
        if check.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("Snapshot contains broken foreign keys")
    finally:
        check.close()
    return text, {"rows": {table: len(rows) for table, rows in tables.items()},
        "admin_roles_restored": include_admins, "sessions_restored": False,
        "note": "Destination must be empty; restore with stop-on-error enabled; review OWNER_IDS separately"}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf8")
        sys.stderr.reconfigure(encoding="utf8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", nargs="?", help="New SQL output file; omitted means stdout")
    parser.add_argument("--output", dest="output_option")
    parser.add_argument("--include-admins", action="store_true")
    parser.add_argument("--report-only", action="store_true")
    args = parser.parse_args()
    if args.output and args.output_option:
        parser.error("Choose either positional output or --output")
    try:
        if args.source.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("Snapshot exceeds 100 MiB safe import size; use a full SQL backup")
        snapshot = json.loads(args.source.read_text(encoding="utf8"))
        sql, report = validate_snapshot(snapshot, args.include_admins)
        if not args.report_only:
            legacy.write_output(sql, args.output or args.output_option, args.source)
        print(json.dumps(report, ensure_ascii=False, indent=2), file=sys.stderr)
    except (OSError, ValueError, sqlite3.Error, TypeError) as error:
        print("Restore conversion aborted without modifying source: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
