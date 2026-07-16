"""Iceberg table operations for the explainer."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any

import boto3
import pyarrow as pa
from pyiceberg.catalog import load_catalog
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import BucketTransform, MonthTransform
from pyiceberg.types import DateType, NestedField, StringType

from backend.metadata import MetadataReader, highlight_metadata_changes
from backend.parquet_reader import ParquetReader

TABLE_ID = "demo.events"
NAMESPACE = "demo"
TABLE_NAME = "events"

S3_ENDPOINT = os.getenv("S3_ENDPOINT", "http://localhost:9000")
S3_ACCESS_KEY = os.getenv("S3_ACCESS_KEY", "rustfsadmin")
S3_SECRET_KEY = os.getenv("S3_SECRET_KEY", "rustfsadmin")
S3_BUCKET = os.getenv("S3_BUCKET", "iceberg-warehouse")
CATALOG_URI = os.getenv("CATALOG_URI", "sqlite:///./data/catalog.db")
WAREHOUSE = os.getenv("WAREHOUSE", f"s3://{S3_BUCKET}/warehouse")

COMPACT_SNAPSHOT_PROPERTIES = {
    "snapshot-type": "replace",
    "replace-operation": "rewrite_data_files",
}


@dataclass
class SnapshotRecord:
    index: int
    snapshot_id: int | None
    label: str
    action: str
    timestamp: str
    row_count: int
    bundle: dict[str, Any] = field(default_factory=dict)


class IcebergExplainer:
    def __init__(self) -> None:
        os.makedirs("data", exist_ok=True)
        self._reader = MetadataReader(S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY)
        self._parquet = ParquetReader(self._reader)
        self._history: list[SnapshotRecord] = []
        self._ensure_bucket()
        self._catalog = load_catalog(
            "default",
            **{
                "type": "sql",
                "uri": CATALOG_URI,
                "warehouse": WAREHOUSE,
                "s3.endpoint": S3_ENDPOINT,
                "s3.access-key-id": S3_ACCESS_KEY,
                "s3.secret-access-key": S3_SECRET_KEY,
                "s3.path-style-access": "true",
                "s3.region": "us-east-1",
            },
        )
        self.reset()

    def _ensure_bucket(self) -> None:
        client = boto3.client(
            "s3",
            endpoint_url=S3_ENDPOINT,
            aws_access_key_id=S3_ACCESS_KEY,
            aws_secret_access_key=S3_SECRET_KEY,
            region_name="us-east-1",
        )
        from botocore.exceptions import ClientError

        try:
            client.head_bucket(Bucket=S3_BUCKET)
        except ClientError:
            client.create_bucket(Bucket=S3_BUCKET)

    def _schema(self) -> Schema:
        return Schema(
            NestedField(1, "date", DateType(), required=True),
            NestedField(2, "state", StringType(), required=True),
            NestedField(3, "value", StringType(), required=True),
        )

    def _partition_spec(self) -> PartitionSpec:
        return PartitionSpec(
            PartitionField(
                source_id=1,
                field_id=1001,
                transform=MonthTransform(),
                name="date_month",
            ),
            PartitionField(
                source_id=2,
                field_id=1002,
                transform=BucketTransform(10),
                name="state_bucket_10",
            ),
        )

    def _drop_table_if_exists(self) -> None:
        try:
            self._catalog.drop_table(TABLE_ID)
        except Exception:
            pass

    def _create_table(self):
        self._catalog.create_namespace_if_not_exists(NAMESPACE)
        return self._catalog.create_table(
            TABLE_ID,
            schema=self._schema(),
            partition_spec=self._partition_spec(),
        )

    def _load_table(self):
        return self._catalog.load_table(TABLE_ID)

    def _capture(self, label: str, action: str) -> SnapshotRecord:
        table = self._load_table()
        table.refresh()
        metadata_location = table.metadata_location
        bundle = self._reader.fetch_snapshot_bundle(metadata_location)
        rows = table.scan().to_arrow()
        record = SnapshotRecord(
            index=len(self._history),
            snapshot_id=bundle["current_snapshot_id"],
            label=label,
            action=action,
            timestamp=datetime.now(timezone.utc).isoformat(),
            row_count=rows.num_rows,
            bundle=bundle,
        )
        self._history.append(record)
        return record

    def reset(self) -> SnapshotRecord:
        self._history.clear()
        self._drop_table_if_exists()
        self._create_table()
        return self._capture("Empty table created", "reset")

    def _parse_date(self, value: str) -> date:
        try:
            return date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(f"Invalid date '{value}', expected YYYY-MM-DD") from exc

    def _arrow_schema(self) -> pa.Schema:
        return pa.schema(
            [
                pa.field("date", pa.date32(), nullable=False),
                pa.field("state", pa.string(), nullable=False),
                pa.field("value", pa.string(), nullable=False),
            ]
        )

    def _format_partition(self, partition: dict[str, int]) -> str:
        return (
            f"month={partition['date_month']}/"
            f"bucket={partition['state_bucket_10']}"
        )

    def get_partitions(self) -> list[dict[str, Any]]:
        table = self._load_table()
        table.refresh()
        if table.current_snapshot() is None:
            return []

        partitions = []
        for part in table.inspect.partitions().to_pylist():
            partition = part["partition"]
            partitions.append(
                {
                    "date_month": partition["date_month"],
                    "state_bucket_10": partition["state_bucket_10"],
                    "record_count": part["record_count"],
                    "file_count": part["file_count"],
                    "needs_compaction": part["file_count"] > 1,
                }
            )
        return partitions

    def compact(self) -> SnapshotRecord:
        table = self._load_table()
        table.refresh()

        if table.current_snapshot() is None or table.scan().to_arrow().num_rows == 0:
            return self._capture("Compact (no-op): table is empty", "compact")

        targets = [
            part
            for part in table.inspect.partitions().to_pylist()
            if part["file_count"] > 1
        ]
        if not targets:
            return self._capture(
                "Compact (no-op): every partition already has one data file",
                "compact",
            )

        compacted = [
            f"{self._format_partition(target['partition'])} ({target['file_count']} files → 1)"
            for target in targets
        ]
        full_table = table.scan().to_arrow().cast(self._arrow_schema())
        table.overwrite(
            full_table,
            snapshot_properties={
                **COMPACT_SNAPSHOT_PROPERTIES,
                "compacted-partitions": ", ".join(compacted),
            },
        )

        label = f"Compacted: {', '.join(compacted)}"
        return self._capture(label, "compact")

    def add_row(self, date_value: str, state: str, value: str) -> SnapshotRecord:
        table = self._load_table()
        parsed_date = self._parse_date(date_value)
        arrow_table = pa.Table.from_pylist(
            [{"date": parsed_date, "state": state, "value": value}],
            schema=self._arrow_schema(),
        )
        table.append(arrow_table)
        label = f"Added row: {date_value} / {state} / {value}"
        return self._capture(label, "append")

    def get_rows(self) -> list[dict[str, str]]:
        table = self._load_table()
        table.refresh()
        arrow = table.scan().to_arrow()
        if arrow.num_rows == 0:
            return []
        return [
            {
                "date": row["date"].isoformat()
                if isinstance(row["date"], date)
                else str(row["date"]),
                "state": row["state"],
                "value": row["value"],
            }
            for row in arrow.to_pylist()
        ]

    def list_snapshots(self) -> list[dict[str, Any]]:
        return [
            {
                "index": record.index,
                "snapshot_id": record.snapshot_id,
                "label": record.label,
                "action": record.action,
                "timestamp": record.timestamp,
                "row_count": record.row_count,
                "metadata_file": record.bundle.get("metadata_location"),
                "manifest_list_path": record.bundle.get("manifest_list_path"),
                "manifest_count": len(record.bundle.get("manifests", [])),
            }
            for record in self._history
        ]

    def get_snapshot(self, index: int) -> dict[str, Any]:
        if index < 0 or index >= len(self._history):
            raise IndexError(f"Snapshot index {index} out of range")
        record = self._history[index]
        return {
            "index": record.index,
            "snapshot_id": record.snapshot_id,
            "label": record.label,
            "action": record.action,
            "timestamp": record.timestamp,
            "row_count": record.row_count,
            **record.bundle,
        }

    def get_parquet_files(self, index: int) -> dict[str, Any]:
        snapshot = self.get_snapshot(index)
        return self._parquet.read_snapshot_data_files(snapshot)

    def diff_snapshots(self, from_index: int, to_index: int) -> dict[str, Any]:
        before = self.get_snapshot(from_index)
        after = self.get_snapshot(to_index)

        metadata_before = before["metadata"]
        metadata_after = after["metadata"]
        manifest_list_before = before.get("manifest_list") or []
        manifest_list_after = after.get("manifest_list") or []

        return {
            "from_index": from_index,
            "to_index": to_index,
            "from_label": before["label"],
            "to_label": after["label"],
            "metadata": highlight_metadata_changes(metadata_before, metadata_after),
            "manifest_list_diff": {
                "before_count": len(manifest_list_before),
                "after_count": len(manifest_list_after),
                "before": manifest_list_before,
                "after": manifest_list_after,
            },
            "manifests_before": before.get("manifests", []),
            "manifests_after": after.get("manifests", []),
        }
