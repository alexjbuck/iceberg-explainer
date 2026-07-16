"""Read Parquet data files and extract row-group statistics."""

from __future__ import annotations

import io
import struct
from datetime import date, datetime, timedelta
from typing import Any

import pyarrow.parquet as pq

from backend.metadata import MetadataReader, parse_s3_uri

# Iceberg manifest entry status
MANIFEST_DELETED = 2


def _json_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.hex()
    if isinstance(value, dict):
        return {k: _json_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_value(v) for v in value]
    return value


def _column_statistics(col_meta: Any) -> dict[str, Any] | None:
    stats = col_meta.statistics
    if stats is None:
        return None

    result: dict[str, Any] = {
        "physical_type": str(col_meta.physical_type),
        "null_count": stats.null_count,
        "distinct_count": stats.distinct_count,
        "num_values": stats.num_values,
    }
    if stats.has_min_max:
        result["min"] = _json_value(stats.min)
        result["max"] = _json_value(stats.max)
    return result


def _decode_iceberg_bound(field_id: int, value: Any) -> Any:
    if value is None:
        return None
    if field_id == 1 and isinstance(value, str) and len(value) == 8:
        try:
            days = struct.unpack("<i", bytes.fromhex(value))[0]
            return (date(1970, 1, 1) + timedelta(days=days)).isoformat()
        except (struct.error, ValueError, OverflowError):
            return value
    return value


def _iceberg_bounds(data_file: dict[str, Any]) -> list[dict[str, Any]]:
    """Summarize column stats Iceberg stores on the data file in manifests."""
    field_names = {1: "date", 2: "state", 3: "value"}
    lowers = {item["key"]: item["value"] for item in (data_file.get("lower_bounds") or [])}
    uppers = {item["key"]: item["value"] for item in (data_file.get("upper_bounds") or [])}
    null_counts = {
        item["key"]: item["value"] for item in (data_file.get("null_value_counts") or [])
    }
    value_counts = {
        item["key"]: item["value"] for item in (data_file.get("value_counts") or [])
    }

    columns = []
    for field_id, name in field_names.items():
        if field_id not in lowers and field_id not in uppers:
            continue
        columns.append(
            {
                "column": name,
                "field_id": field_id,
                "lower_bound": _decode_iceberg_bound(field_id, lowers.get(field_id)),
                "upper_bound": _decode_iceberg_bound(field_id, uppers.get(field_id)),
                "null_count": null_counts.get(field_id),
                "value_count": value_counts.get(field_id),
            }
        )
    return columns


class ParquetReader:
    def __init__(self, metadata_reader: MetadataReader) -> None:
        self._reader = metadata_reader

    def read_file(self, path: str, iceberg_data_file: dict[str, Any] | None = None) -> dict[str, Any]:
        bucket, key = parse_s3_uri(path)
        response = self._reader._client.get_object(Bucket=bucket, Key=key)
        raw = response["Body"].read()
        file_size = response.get("ContentLength", len(raw))

        buffer = io.BytesIO(raw)
        parquet_file = pq.ParquetFile(buffer)
        table = parquet_file.read()
        columns = table.column_names
        rows = [_json_value(row) for row in table.to_pylist()]

        row_groups = []
        metadata = parquet_file.metadata
        schema = parquet_file.schema_arrow
        for group_index in range(metadata.num_row_groups):
            row_group = metadata.row_group(group_index)
            column_stats = []
            for column_index in range(row_group.num_columns):
                col_meta = row_group.column(column_index)
                name = schema.names[column_index]
                stats = _column_statistics(col_meta)
                if stats:
                    stats["column"] = name
                    column_stats.append(stats)
            row_groups.append(
                {
                    "index": group_index,
                    "num_rows": row_group.num_rows,
                    "total_byte_size": row_group.total_byte_size,
                    "columns": column_stats,
                }
            )

        result: dict[str, Any] = {
            "path": path,
            "file_name": path.rsplit("/", 1)[-1],
            "file_size_bytes": file_size,
            "num_rows": metadata.num_rows,
            "columns": columns,
            "rows": rows,
            "row_groups": row_groups,
        }

        if iceberg_data_file:
            result["partition"] = _json_value(iceberg_data_file.get("partition"))
            result["record_count"] = iceberg_data_file.get("record_count")
            result["iceberg_manifest_stats"] = _iceberg_bounds(iceberg_data_file)

        return result

    def read_snapshot_data_files(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        files: list[dict[str, Any]] = []
        for manifest in snapshot.get("manifests", []):
            for entry in manifest.get("entries", []):
                if entry.get("status") == MANIFEST_DELETED:
                    continue
                data_file = entry.get("data_file") or {}
                path = data_file.get("file_path")
                if not path:
                    continue
                files.append(self.read_file(path, iceberg_data_file=data_file))

        return {"files": files, "file_count": len(files)}
