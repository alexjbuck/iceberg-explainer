# Iceberg Metadata Explainer

A minimal, hands-on tool for exploring how Apache Iceberg metadata files evolve as you write data.

**Stack (intentionally simple):**
- **Catalog:** SQLite via PyIceberg `SqlCatalog`
- **Storage:** RustFS (local S3-compatible object store)
- **Engine:** PyIceberg + PyArrow
- **UI:** FastAPI + vanilla HTML/JS

## What it shows

- A table with three columns: `date` (date), `state` (string), `value` (string)
- Partition spec: `month(date)` and `bucket[10](state)`
- Each append creates a new Iceberg snapshot
- Scrub through snapshots to time-travel
- Inspect the current `metadata.json`, manifest list Avro file, and manifest Avro files
- Diff view comparing each snapshot to the previous one

## Quick start

### 1. Start RustFS

```bash
docker compose up -d
```

S3 API: `http://localhost:9000`  
Console: `http://localhost:9001` (credentials: `rustfsadmin` / `rustfsadmin`)

### 2. Install and run the app

```bash
uv sync
uv run uvicorn backend.main:app --reload --port 8080
```

Open **http://localhost:8080**

### 3. Try it

1. Click **Reset table** to start fresh (empty table snapshot)
2. Add a row like `2026-07-16` / `CA` / `hello`
3. Add another row with the **same month and state bucket** (e.g. two July dates with `CA`) — creates a second file in that partition
4. Click **Compact partitions** — runs `rewrite_data_files` per partition (merges files, same rows)
5. Scrub the snapshot slider and open **diff vs previous** to see manifest/metadata changes

## Project layout

```
backend/
  main.py              # FastAPI routes
  iceberg_service.py   # Table writes + snapshot history
  metadata.py          # S3 metadata/manifest file reader
static/
  index.html           # Web UI
  app.js
  styles.css
data/                  # Created at runtime (SQLite catalog)
docker-compose.yml     # RustFS
```

## Environment variables

| Variable | Default |
|----------|---------|
| `S3_ENDPOINT` | `http://localhost:9000` |
| `S3_ACCESS_KEY` | `rustfsadmin` |
| `S3_SECRET_KEY` | `rustfsadmin` |
| `S3_BUCKET` | `iceberg-warehouse` |
| `CATALOG_URI` | `sqlite:///./data/catalog.db` |
| `WAREHOUSE` | `s3://iceberg-warehouse/warehouse` |
