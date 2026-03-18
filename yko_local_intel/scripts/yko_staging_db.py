#!/usr/bin/env python3
"""YKO Local Intelligence staging database utility.

This utility creates and manages a local-only SQLite database intended for
staging intelligence data before optional import into Cloudflare D1.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sqlite3
from pathlib import Path
from typing import Any

DEFAULT_DB_PATH = Path("yko_local_intel/data/yko_staging.sqlite")
DEFAULT_JSON_EXPORT_PATH = Path("yko_local_intel/json_snapshots/yko_snapshot.json")
DEFAULT_SQL_EXPORT_PATH = Path("yko_local_intel/sql_exports/yko_inserts.sql")


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def connect_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def initialize_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS brands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL,
            city TEXT,
            county TEXT,
            state TEXT DEFAULT 'CA',
            website TEXT,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            brand_id INTEGER NOT NULL,
            claim_text TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            source TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS evidence (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            claim_id INTEGER NOT NULL,
            evidence_text TEXT NOT NULL,
            evidence_type TEXT DEFAULT 'document',
            source_url TEXT,
            captured_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (claim_id) REFERENCES claims (id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_brands_category ON brands (category);
        CREATE INDEX IF NOT EXISTS idx_claims_brand_id ON claims (brand_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_claim_id ON evidence (claim_id);
        """
    )
    conn.commit()


def upsert_brand(conn: sqlite3.Connection, row: dict[str, str]) -> None:
    now = utc_now_iso()
    conn.execute(
        """
        INSERT INTO brands (
            name, category, city, county, state, website, description, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            category=excluded.category,
            city=excluded.city,
            county=excluded.county,
            state=excluded.state,
            website=excluded.website,
            description=excluded.description,
            updated_at=excluded.updated_at
        """,
        (
            row.get("name", "").strip(),
            row.get("category", "").strip(),
            row.get("city", "").strip() or None,
            row.get("county", "").strip() or None,
            row.get("state", "CA").strip() or "CA",
            row.get("website", "").strip() or None,
            row.get("description", "").strip() or None,
            now,
            now,
        ),
    )


def import_brands_csv(conn: sqlite3.Connection, csv_path: Path) -> int:
    required = {"name", "category", "city", "county", "state", "website", "description"}
    count = 0
    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError("CSV has no header row.")
        missing = required - set(reader.fieldnames)
        if missing:
            raise ValueError(f"CSV is missing required columns: {sorted(missing)}")
        for row in reader:
            if not row.get("name") or not row.get("category"):
                continue
            upsert_brand(conn, row)
            count += 1
    conn.commit()
    return count


def add_claim(conn: sqlite3.Connection, brand_name: str, claim_text: str, status: str, source: str | None) -> int:
    brand = conn.execute("SELECT id FROM brands WHERE name = ?", (brand_name,)).fetchone()
    if not brand:
        raise ValueError(f"Brand not found: {brand_name}")
    now = utc_now_iso()
    cur = conn.execute(
        """
        INSERT INTO claims (brand_id, claim_text, status, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (brand["id"], claim_text.strip(), status.strip(), source, now, now),
    )
    conn.commit()
    return int(cur.lastrowid)


def add_evidence(conn: sqlite3.Connection, claim_id: int, evidence_text: str, evidence_type: str, source_url: str | None) -> int:
    claim = conn.execute("SELECT id FROM claims WHERE id = ?", (claim_id,)).fetchone()
    if not claim:
        raise ValueError(f"Claim not found: {claim_id}")
    now = utc_now_iso()
    cur = conn.execute(
        """
        INSERT INTO evidence (claim_id, evidence_text, evidence_type, source_url, captured_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (claim_id, evidence_text.strip(), evidence_type.strip(), source_url, now, now, now),
    )
    conn.commit()
    return int(cur.lastrowid)


def table_rows(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    rows = conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
    return [dict(row) for row in rows]


def export_json_snapshot(conn: sqlite3.Connection, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": {
            "exported_at": utc_now_iso(),
            "db_type": "sqlite",
            "mode": "local_staging_only",
        },
        "brands": table_rows(conn, "brands"),
        "claims": table_rows(conn, "claims"),
        "evidence": table_rows(conn, "evidence"),
    }
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def export_sql_inserts(conn: sqlite3.Connection, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "-- YKO local staging export for Cloudflare D1 import",
        f"-- Generated at {utc_now_iso()}",
        "BEGIN TRANSACTION;",
    ]
    for table in ("brands", "claims", "evidence"):
        rows = table_rows(conn, table)
        if not rows:
            continue
        columns = list(rows[0].keys())
        col_sql = ", ".join(columns)
        for row in rows:
            values_sql = ", ".join(sql_literal(row[col]) for col in columns)
            lines.append(f"INSERT INTO {table} ({col_sql}) VALUES ({values_sql});")
    lines.append("COMMIT;")
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage a local SQLite staging DB for YKO intelligence.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, help="SQLite DB path (local only).")

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db", help="Initialize local staging schema.")

    import_cmd = sub.add_parser("import-brands", help="Import or upsert brands from CSV.")
    import_cmd.add_argument("--csv", type=Path, required=True, help="Path to brands CSV file.")

    claim_cmd = sub.add_parser("add-claim", help="Add a claim tied to a brand.")
    claim_cmd.add_argument("--brand", required=True, help="Brand name exactly as stored.")
    claim_cmd.add_argument("--text", required=True, help="Claim text.")
    claim_cmd.add_argument("--status", default="pending", choices=["pending", "verified", "disputed"], help="Claim status.")
    claim_cmd.add_argument("--source", default=None, help="Optional claim source.")

    evidence_cmd = sub.add_parser("add-evidence", help="Add evidence tied to a claim id.")
    evidence_cmd.add_argument("--claim-id", type=int, required=True, help="Claim id.")
    evidence_cmd.add_argument("--text", required=True, help="Evidence text.")
    evidence_cmd.add_argument("--type", default="document", help="Evidence type label.")
    evidence_cmd.add_argument("--source-url", default=None, help="Optional source URL.")

    json_cmd = sub.add_parser("export-json", help="Export JSON snapshot.")
    json_cmd.add_argument("--out", type=Path, default=DEFAULT_JSON_EXPORT_PATH, help="Output JSON path.")

    sql_cmd = sub.add_parser("export-sql", help="Export SQL INSERT statements for D1 import.")
    sql_cmd.add_argument("--out", type=Path, default=DEFAULT_SQL_EXPORT_PATH, help="Output SQL file path.")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    conn = connect_db(args.db)

    if args.command == "init-db":
        initialize_db(conn)
        print(f"Initialized local staging DB at: {args.db}")
    elif args.command == "import-brands":
        initialize_db(conn)
        imported = import_brands_csv(conn, args.csv)
        print(f"Imported/upserted {imported} brand rows from {args.csv}")
    elif args.command == "add-claim":
        initialize_db(conn)
        claim_id = add_claim(conn, args.brand, args.text, args.status, args.source)
        print(f"Added claim id={claim_id} for brand={args.brand}")
    elif args.command == "add-evidence":
        initialize_db(conn)
        evidence_id = add_evidence(conn, args.claim_id, args.text, args.type, args.source_url)
        print(f"Added evidence id={evidence_id} for claim_id={args.claim_id}")
    elif args.command == "export-json":
        initialize_db(conn)
        export_json_snapshot(conn, args.out)
        print(f"Exported JSON snapshot to: {args.out}")
    elif args.command == "export-sql":
        initialize_db(conn)
        export_sql_inserts(conn, args.out)
        print(f"Exported SQL inserts to: {args.out}")


if __name__ == "__main__":
    main()
