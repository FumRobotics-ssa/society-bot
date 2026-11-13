#!/usr/bin/env python3
"""Read an original siahe SQLite snapshot and emit SQL for an EMPTY new database.

This script never opens the original database for writing and never executes
anything against a deployed database. Review the report before importing SQL.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import time
import uuid

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
SCHEMA = MIGRATIONS / "0001_init.sql"
DESTINATION_TABLES = (
    "users", "places", "events", "orders", "tickets", "admins", "audit_log",
    "conversation_states", "inbox", "outbox", "admin_sessions", "login_codes",
    "legacy_events", "legacy_event_participants",
)
PROFILE_FIELDS = (
    "is_boy", "is_fum_student", "student_number", "fum_faculty", "is_student",
    "is_mashhad_student", "university_name", "entrance_year", "is_mast_phd",
    "student_major", "is_graduate_student", "is_student_relative",
)


def positive(value, description, maximum=9007199254740991):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > maximum:
        raise ValueError(f"Invalid {description}: expected a positive integer")
    return value


def quote(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        if value < -(2**63) or value > 2**63-1:
            raise ValueError("Integer outside SQLite range")
        return str(value)
    if isinstance(value, str) and "\0" not in value:
        return "'" + value.replace("'", "''") + "'"
    raise ValueError("Unsupported SQL value type or NUL in a string")


def insert(table, row):
    names = ",".join('"' + name + '"' for name in row)
    values = ",".join(quote(value) for value in row.values())
    return f'INSERT INTO "{table}" ({names}) VALUES ({values});'


def empty_guard():
    counts = "+".join(f'(SELECT COUNT(*) FROM "{name}")' for name in DESTINATION_TABLES)
    return [
        "-- Apply only to a NEW database after migrations/0001_init.sql",
        "-- The first constraint deliberately aborts if the destination is not empty",
        "CREATE TABLE __robotics_empty_guard (empty INTEGER CHECK(empty=1));",
        f"INSERT INTO __robotics_empty_guard SELECT CASE WHEN ({counts})=0 THEN 1 ELSE 0 END;",
    ]


def purchase_timestamp(value, now, warnings):
    if value is None or value == "":
        warnings.append("One missing purchase timestamp replaced with migration time")
        return now
    if isinstance(value, int):
        return value
    if not isinstance(value, str):
        raise ValueError("Unsupported legacy purchase_time value")
    date = value.strip().replace("Z", "+00:00")
    # Older Go string renderings can carry both a numeric zone and its name.
    date = re.sub(r" ([+-]\d{2})(\d{2}) [A-Za-z]+$", r"\1:\2", date)
    try:
        dt = datetime.fromisoformat(date)
        if dt.tzinfo is None:
            warnings.append("One timezone-less purchase timestamp interpreted as UTC")
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except (ValueError, OverflowError, OSError) as error:
        raise ValueError("Unsupported legacy purchase_time format") from error


def read_source(path):
    source = path.resolve(strict=True)
    connection = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = {"users", "places", "events", "tickets"} - tables
        if missing:
            raise ValueError("Missing original tables: " + ", ".join(sorted(missing)))
        return {table: [dict(row) for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY id')]
                for table in ("users", "places", "events", "tickets")}
    finally:
        connection.close()


def make_migration(data, keep_active=False):
    now = int(time.time())
    warnings = []
    users = {positive(row.get("id"), "user ID"): row for row in data["users"]}
    places = {positive(row.get("id"), "place ID"): row for row in data["places"]}
    events = {positive(row.get("id"), "event ID"): row for row in data["events"]}
    approved = Counter()
    per_user = Counter()
    codes = set()
    for ticket in data["tickets"]:
        code = str(positive(ticket.get("id"), "ticket code"))
        if code in codes:
            raise ValueError("Duplicate legacy ticket code")
        codes.add(code)
        if ticket.get("user_id") not in users or ticket.get("event_id") not in events:
            raise ValueError(f"Orphan ticket {code}: missing user or event; no tickets were discarded")
        if ticket.get("status") not in {"reserved", "completed", "attended"}:
            raise ValueError(f"Unsupported ticket status for legacy ticket {code}")
        if ticket["status"] != "reserved":
            approved[ticket["event_id"]] += 1
            per_user[(ticket["event_id"], ticket["user_id"])] += 1
    for event in events.values():
        if event.get("place_id") not in places:
            raise ValueError(f"Event {event['id']} references a missing place")
    rows = {"users": [], "places": [], "events": [], "orders": [], "tickets": []}
    checkin_codes = set()
    for user_id, user in users.items():
        profile = {key: user[key] for key in PROFILE_FIELDS if key in user}
        profile["registered"] = True
        rows["users"].append({"id": user_id, "username": "", "first_name": user.get("first_name") or "",
            "last_name": user.get("last_name") or "", "phone": user.get("phone_number") or "",
            "profile_json": json.dumps(profile, ensure_ascii=False, separators=(",", ":")),
            "is_deleted": 0, "created_at": now, "updated_at": now})
    for place_id, place in places.items():
        capacity = positive(place.get("capacity"), f"capacity of place {place_id}", 1000000)
        rows["places"].append({"id": place_id, "name": place.get("name") or f"Legacy place {place_id}",
            "address": place.get("address") or "", "capacity": capacity, "created_at": now})
    adjustments = []
    for event_id, event in events.items():
        capacity = positive(places[event["place_id"]].get("capacity"), "place capacity", 1000000)
        old_max = event.get("max_ticket_batch")
        if not isinstance(old_max, int) or old_max < 0:
            raise ValueError(f"Invalid max_ticket_batch in event {event_id}")
        actual_max = max((count for (eid, _), count in per_user.items() if eid == event_id), default=0)
        max_per_user = max(1, old_max, actual_max)
        if max_per_user > 100:
            raise ValueError(f"Event {event_id} requires max_per_user {max_per_user} above supported limit 100")
        new_capacity = max(capacity, approved[event_id])
        if new_capacity != capacity:
            adjustments.append(f"Event {event_id} capacity widened from {capacity} to {new_capacity} to preserve approved tickets")
        if max_per_user != old_max:
            adjustments.append(f"Event {event_id} max_per_user changed from {old_max} to {max_per_user} to preserve approved tickets")
        rows["events"].append({"id": event_id, "name": event.get("name") or f"Legacy event {event_id}",
            "description": event.get("description") or "", "place_id": event["place_id"],
            "capacity": new_capacity, "max_per_user": max_per_user, "is_paid": int(bool(event.get("is_paid"))),
            "price": 0, "payment_instructions": "", "starts_at": "",
            "active": int(bool(event.get("is_active"))) if keep_active else 0, "archived": 0,
            "created_at": now, "updated_at": now})
    expired = 0
    attended = 0
    for ticket in data["tickets"]:
        code = str(ticket["id"])
        order_id = str(uuid.uuid4())
        purchased = purchase_timestamp(ticket.get("purchase_time"), now, warnings)
        is_reserved = ticket["status"] == "reserved"
        expired += int(is_reserved)
        is_attended = ticket["status"] == "attended"
        attended += int(is_attended)
        rows["orders"].append({"id": order_id, "request_key": "legacy:" + code,
            "user_id": ticket["user_id"], "event_id": ticket["event_id"], "quantity": 1,
            "unit_price": 0, "status": "expired" if is_reserved else "approved",
            "expires_at": now - 1 if is_reserved else None, "receipt_file_id": None,
            "receipt_type": None, "receipt_key": None, "reviewed_by": None,
            "reviewed_at": None, "created_at": purchased, "updated_at": now})
        checkin_code = f"{secrets.randbelow(100_000_000):08d}"
        while checkin_code in checkin_codes:
            checkin_code = f"{secrets.randbelow(100_000_000):08d}"
        checkin_codes.add(checkin_code)
        rows["tickets"].append({"id": str(uuid.uuid4()), "token": secrets.token_hex(32),
            "checkin_code": checkin_code,
            "legacy_code": code, "order_id": order_id,
            "checked_in_at": purchased if is_attended else None, "checked_in_by": None,
            "created_at": purchased})
    report = {"users": len(users), "places": len(places), "events": len(events), "tickets": len(codes),
        "unverified_reservations_expired": expired, "attended_tickets": attended,
        "legacy_privileges_imported": False, "legacy_access_hashes_imported": False,
        "events_default_inactive": not keep_active, "historic_prices_unknown_set_to_zero": True,
        "adjustments": adjustments, "timestamp_warnings": dict(Counter(warnings)),
        "attendance_time_note": "Old schema has no attendance timestamp; purchase time retained as historical marker"}
    sql = empty_guard()
    for table, items in rows.items():
        sql.extend(insert(table, row) for row in items)
    sql.append("DROP TABLE __robotics_empty_guard;")
    text = "\n".join(sql) + "\n"
    # Full validation happens in an isolated throwaway database before any output is written.
    check = sqlite3.connect(":memory:")
    try:
        check.executescript(SCHEMA.read_text(encoding="utf8"))
        check.executescript((MIGRATIONS / "0002_place_map_url.sql").read_text(encoding="utf8"))
        check.executescript((MIGRATIONS / "0003_legacy_event_audience.sql").read_text(encoding="utf8"))
        check.executescript((MIGRATIONS / "0004_ticket_checkin_code.sql").read_text(encoding="utf8"))
        check.executescript(text)
        if check.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("Migration contains broken foreign keys")
    finally:
        check.close()
    return text, report


def write_output(text, path, source):
    if not path:
        sys.stdout.write(text)
        return
    output = Path(path)
    if output.resolve() == source.resolve():
        raise ValueError("Output must never replace the source database")
    with output.open("x", encoding="utf8", newline="\n") as handle:
        handle.write(text)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf8")
        sys.stderr.reconfigure(encoding="utf8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", nargs="?", help="New SQL output file; omitted means stdout")
    parser.add_argument("--output", dest="output_option")
    parser.add_argument("--report-only", action="store_true")
    parser.add_argument("--keep-active-events", action="store_true", help="Explicitly retain legacy active flags; review prices first")
    args = parser.parse_args()
    if args.output and args.output_option:
        parser.error("Choose either positional output or --output")
    try:
        sql, report = make_migration(read_source(args.source), args.keep_active_events)
        if not args.report_only:
            write_output(sql, args.output or args.output_option, args.source)
        print(json.dumps(report, ensure_ascii=False, indent=2), file=sys.stderr)
    except (OSError, ValueError, sqlite3.Error) as error:
        print("Migration aborted without modifying source: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
