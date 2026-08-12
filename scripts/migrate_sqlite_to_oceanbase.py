from __future__ import annotations

import argparse
import os
import warnings
from pathlib import Path
from typing import Any

from sqlalchemy import MetaData, create_engine, delete, insert, select, text
from sqlalchemy.exc import SAWarning


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Copy an existing StaffDeck SQLite database into OceanBase MySQL mode."
    )
    parser.add_argument(
        "--source", type=Path, required=True, help="Path to the SQLite database"
    )
    parser.add_argument(
        "--target",
        default=os.environ.get("DATABASE_URL", ""),
        help="OceanBase SQLAlchemy URL; defaults to DATABASE_URL",
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Delete existing target rows before copying the SQLite data",
    )
    parser.add_argument("--batch-size", type=int, default=500)
    return parser.parse_args()


def _copy_rows(
    source_connection: Any,
    target_connection: Any,
    source_table: Any,
    target_table: Any,
    batch_size: int,
) -> int:
    target_columns = {column.name for column in target_table.columns}
    rows = source_connection.execute(select(source_table)).mappings()
    batch: list[dict[str, Any]] = []
    copied = 0
    for row in rows:
        batch.append(
            {key: value for key, value in row.items() if key in target_columns}
        )
        if len(batch) >= batch_size:
            target_connection.execute(insert(target_table), batch)
            copied += len(batch)
            batch.clear()
    if batch:
        target_connection.execute(insert(target_table), batch)
        copied += len(batch)
    return copied


def main() -> None:
    args = _arguments()
    source_path = args.source.expanduser().resolve()
    if not source_path.is_file():
        raise SystemExit(f"SQLite database does not exist: {source_path}")
    if not args.target:
        raise SystemExit("Pass --target or set DATABASE_URL")
    if not args.target.startswith("mysql+"):
        raise SystemExit("Target must use a MySQL-compatible SQLAlchemy URL")
    if args.batch_size < 1:
        raise SystemExit("--batch-size must be positive")

    source_engine = create_engine(f"sqlite:///{source_path}")
    target_engine = create_engine(args.target, pool_pre_ping=True)
    source_metadata = MetaData()
    target_metadata = MetaData()
    source_metadata.reflect(bind=source_engine)
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Unknown schema content:",
            category=SAWarning,
        )
        target_metadata.reflect(bind=target_engine)

    shared_names = [
        name for name in source_metadata.tables if name in target_metadata.tables
    ]
    if not shared_names:
        raise SystemExit("Source and target databases have no shared tables")

    copied_total = 0
    with (
        source_engine.connect() as source_connection,
        target_engine.begin() as target_connection,
    ):
        target_connection.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        try:
            if args.replace:
                for table in reversed(target_metadata.sorted_tables):
                    target_connection.execute(delete(table))

            for name in shared_names:
                copied = _copy_rows(
                    source_connection,
                    target_connection,
                    source_metadata.tables[name],
                    target_metadata.tables[name],
                    args.batch_size,
                )
                copied_total += copied
                print(f"{name}: {copied}")
        finally:
            target_connection.execute(text("SET FOREIGN_KEY_CHECKS = 1"))

    print(f"Copied {copied_total} rows across {len(shared_names)} tables.")


if __name__ == "__main__":
    main()
