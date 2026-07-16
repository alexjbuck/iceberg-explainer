"""FastAPI application for the Iceberg metadata explainer."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.iceberg_service import IcebergExplainer

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="Iceberg Metadata Explainer", version="0.1.0")
explainer = IcebergExplainer()


class RowInput(BaseModel):
    date: str = Field(..., examples=["2026-07-16"])
    state: str = Field(..., examples=["CA"])
    value: str = Field(..., examples=["hello"])


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/compact")
def compact() -> dict:
    snapshot = explainer.compact()
    return {
        "rows": explainer.get_rows(),
        "partitions": explainer.get_partitions(),
        "snapshot_index": snapshot.index,
        "snapshot": explainer.get_snapshot(snapshot.index),
    }


@app.get("/api/partitions")
def get_partitions() -> dict:
    return {"partitions": explainer.get_partitions()}


@app.get("/api/rows")
def get_rows() -> dict:
    return {"rows": explainer.get_rows(), "partitions": explainer.get_partitions()}


@app.post("/api/rows")
def add_row(row: RowInput) -> dict:
    try:
        snapshot = explainer.add_row(row.date, row.state, row.value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "rows": explainer.get_rows(),
        "partitions": explainer.get_partitions(),
        "snapshot_index": snapshot.index,
        "snapshot": explainer.get_snapshot(snapshot.index),
    }


@app.post("/api/reset")
def reset() -> dict:
    snapshot = explainer.reset()
    return {
        "rows": explainer.get_rows(),
        "partitions": explainer.get_partitions(),
        "snapshot_index": snapshot.index,
        "snapshot": explainer.get_snapshot(snapshot.index),
    }


@app.get("/api/snapshots")
def list_snapshots() -> dict:
    return {"snapshots": explainer.list_snapshots()}


@app.get("/api/snapshots/{index}")
def get_snapshot(index: int) -> dict:
    try:
        return explainer.get_snapshot(index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/snapshots/{index}/parquet")
def get_parquet_files(index: int) -> dict:
    try:
        return explainer.get_parquet_files(index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/diff")
def diff_snapshots(from_index: int, to_index: int) -> dict:
    try:
        return explainer.diff_snapshots(from_index, to_index)
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
