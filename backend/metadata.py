"""Read and decode Iceberg metadata files from S3."""

from __future__ import annotations

import io
import json
from typing import Any
from urllib.parse import urlparse

import boto3
import fastavro
from botocore.client import BaseClient


def parse_s3_uri(uri: str) -> tuple[str, str]:
    parsed = urlparse(uri)
    if parsed.scheme != "s3":
        raise ValueError(f"Expected s3 URI, got: {uri}")
    return parsed.netloc, parsed.path.lstrip("/")


class MetadataReader:
    def __init__(
        self,
        endpoint_url: str,
        access_key: str,
        secret_key: str,
        region: str = "us-east-1",
    ) -> None:
        self._client: BaseClient = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
        )

    def read_json(self, uri: str) -> dict[str, Any]:
        bucket, key = parse_s3_uri(uri)
        response = self._client.get_object(Bucket=bucket, Key=key)
        return json.loads(response["Body"].read())

    def read_avro(self, uri: str) -> list[dict[str, Any]]:
        bucket, key = parse_s3_uri(uri)
        response = self._client.get_object(Bucket=bucket, Key=key)
        raw = response["Body"].read()
        records: list[dict[str, Any]] = []
        with io.BytesIO(raw) as buf:
            for record in fastavro.reader(buf):
                records.append(_serialize_avro(record))
        return records

    def fetch_snapshot_bundle(self, metadata_location: str) -> dict[str, Any]:
        """Load metadata JSON, manifest list, and all referenced manifests."""
        metadata = self.read_json(metadata_location)

        snapshots = metadata.get("snapshots") or []
        current_snapshot_id = metadata.get("current-snapshot-id")
        current_snapshot = next(
            (s for s in snapshots if s.get("snapshot-id") == current_snapshot_id),
            snapshots[-1] if snapshots else None,
        )

        manifest_list_path = None
        manifest_list_records: list[dict[str, Any]] = []
        manifests: list[dict[str, Any]] = []

        if current_snapshot and current_snapshot.get("manifest-list"):
            manifest_list_path = current_snapshot["manifest-list"]
            manifest_list_records = self.read_avro(manifest_list_path)

            for entry in manifest_list_records:
                manifest_path = entry.get("manifest_path")
                if not manifest_path:
                    continue
                manifest_records = self.read_avro(manifest_path)
                manifests.append(
                    {
                        "path": manifest_path,
                        "manifest_list_entry": entry,
                        "entries": manifest_records,
                    }
                )

        return {
            "metadata_location": metadata_location,
            "metadata": metadata,
            "current_snapshot_id": current_snapshot_id,
            "manifest_list_path": manifest_list_path,
            "manifest_list": manifest_list_records,
            "manifests": manifests,
        }


def _serialize_avro(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _serialize_avro(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_serialize_avro(v) for v in value]
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.hex()
    if hasattr(value, "items"):
        return {k: _serialize_avro(v) for k, v in value.items()}
    return value


def metadata_filename(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def short_path(path: str | None) -> str:
    if not path:
        return "(none)"
    return path.rsplit("/", 1)[-1]


def diff_dicts(before: dict[str, Any] | None, after: dict[str, Any] | None) -> dict[str, Any]:
    """Return a simple structural diff for the UI."""
    from deepdiff import DeepDiff

    if before is None and after is None:
        return {"kind": "none"}
    if before is None:
        return {"kind": "added", "after": after}
    if after is None:
        return {"kind": "removed", "before": before}

    diff = DeepDiff(before, after, ignore_order=True)
    return {
        "kind": "changed" if diff else "unchanged",
        "values_changed": _format_diff_section(diff.get("values_changed", {})),
        "dictionary_item_added": list(diff.get("dictionary_item_added", [])),
        "dictionary_item_removed": list(diff.get("dictionary_item_removed", [])),
        "iterable_item_added": _format_iterable_diff(diff.get("iterable_item_added", {})),
        "iterable_item_removed": _format_iterable_diff(diff.get("iterable_item_removed", {})),
    }


def _format_diff_section(section: dict[str, Any]) -> list[dict[str, Any]]:
    formatted = []
    for path, change in section.items():
        formatted.append(
            {
                "path": path,
                "old_value": change.get("old_value"),
                "new_value": change.get("new_value"),
            }
        )
    return formatted


def _format_iterable_diff(section: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"path": path, "value": value} for path, value in section.items()]


def highlight_metadata_changes(metadata_before: dict, metadata_after: dict) -> dict[str, Any]:
    """Focus diff on the parts users care about: snapshots and manifest lists."""
    before_snapshots = {
        s["snapshot-id"]: s for s in (metadata_before.get("snapshots") or [])
    }
    after_snapshots = {
        s["snapshot-id"]: s for s in (metadata_after.get("snapshots") or [])
    }

    added_snapshot_ids = sorted(set(after_snapshots) - set(before_snapshots))
    new_snapshots = [after_snapshots[sid] for sid in added_snapshot_ids]

    return {
        "current_snapshot_id": {
            "before": metadata_before.get("current-snapshot-id"),
            "after": metadata_after.get("current-snapshot-id"),
        },
        "metadata_location": {
            "before": metadata_before.get("metadata-location"),
            "after": metadata_after.get("metadata-location"),
        },
        "new_snapshots": new_snapshots,
        "snapshot_count": {
            "before": len(before_snapshots),
            "after": len(after_snapshots),
        },
        "full_diff": diff_dicts(metadata_before, metadata_after),
    }
