# Iceberg Metadata Explainer

A minimal, hands-on tool for exploring how Apache Iceberg metadata files evolve as you write data.

Two self-contained variants live in this repo:

| Variant | Directory | Stack | Deploy |
|---------|-----------|-------|--------|
| **Browser** | [`wasm/`](wasm/) | TypeScript + [icebird](https://github.com/hyparam/icebird) | [GitHub Pages](https://alexjbuck.github.io/iceberg-explainer/) (auto-deployed from `main`) |
| **Docker** | [`docker/`](docker/) | PyIceberg + FastAPI + RustFS | Local only |

Both implement the same demo:

- Table columns: `date`, `state`, `value`
- Partition spec: `month(date)` and `bucket[10](state)`
- Append rows → new snapshots
- Compact partitions (merge data files per partition)
- Scrub snapshot timeline, inspect metadata/manifests, diff vs previous, read parquet files

## Quick start — browser (no install)

Open the live demo: **https://alexjbuck.github.io/iceberg-explainer/**

Or run locally:

```bash
cd wasm
npm install
npm run dev
```

Embed in a blog post with `?embed=1` (hides header chrome).

## Quick start — Docker + PyIceberg

```bash
cd docker
docker compose up -d
uv sync
uv run uvicorn backend.main:app --reload --port 8080
```

Open **http://localhost:8080**

See [`docker/README.md`](docker/README.md) for environment variables and layout.

## Project layout

```
wasm/                  # Client-only variant (GitHub Pages)
docker/                # Server variant (PyIceberg + RustFS)
  backend/
  static/
  docker-compose.yml
.github/workflows/     # Builds wasm/ and deploys to GitHub Pages
```
