# Docker variant

PyIceberg + FastAPI backend with RustFS as local S3-compatible storage and a SQLite catalog.

## Quick start

```bash
cd docker
docker compose up -d
uv sync
uv run uvicorn backend.main:app --reload --port 8080
```

Open **http://localhost:8080**

RustFS console: **http://localhost:9001** (`rustfsadmin` / `rustfsadmin`)

## Try it

1. Click **Reset table** — empty table snapshot
2. Add rows like `2026-07-16` / `CA` / `hello`
3. Add another row in the same month + state bucket — second data file in that partition
4. Click **Compact partitions** — merges files per partition via `rewrite_data_files`
5. Scrub the snapshot slider and open **diff vs previous**

## Layout

```
backend/
  main.py              # FastAPI routes
  iceberg_service.py   # Table writes + snapshot history
  metadata.py          # S3 metadata/manifest file reader
  parquet_reader.py    # Parquet row + footer stats reader
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

Run commands from the `docker/` directory so relative paths resolve correctly.
