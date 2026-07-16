# Browser variant

Runs entirely in the browser — no backend, Docker, or network calls. Uses [icebird](https://github.com/hyparam/icebird) for Iceberg table operations and an in-memory object store instead of S3.

## Development

```bash
cd web
npm install
npm run dev
```

## Production build

```bash
cd web
npm install
npm run build
```

Output goes to `web/dist/`. For GitHub Pages the workflow sets `BASE_PATH=/<repo-name>/` automatically. For a custom subpath:

```bash
BASE_PATH=/my-path/ npm run build
```

## Embed mode

Append `?embed=1` to hide the page header — useful for iframe embeds in blog posts.

## Row operations

Tables are created as **format v2** with `write.delete.mode=merge-on-read`.

- **Add row** — append snapshot, new data file
- **Delete** — position delete snapshot; writes a `(file_path, pos)` delete file without rewriting data
- **Compact partitions** — rewrite data files (physically removes deleted rows)

## Layout

```
src/
  explainer.ts     # Iceberg table ops + snapshot history
  rowLocations.ts  # Map visible rows → file_path + row position
  memoryStore.ts   # In-memory S3 substitute
  metadata.ts      # Manifest list / manifest decoding
  parquet.ts       # Parquet row + stats reader
  app.ts           # UI logic
  main.ts          # Entry point
  style.css
```

## Prototype script

`test-explorer.mjs` is a quick icebird smoke test (not part of the build):

```bash
node test-explorer.mjs
```
