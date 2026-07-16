# Browser variant

Runs entirely in the browser — no backend, Docker, or network calls. Uses [icebird](https://github.com/hyparam/icebird) for Iceberg table operations and an in-memory object store instead of S3.

## Development

```bash
cd wasm
npm install
npm run dev
```

## Production build

```bash
cd wasm
npm install
npm run build
```

Output goes to `wasm/dist/`. For GitHub Pages the workflow sets `BASE_PATH=/<repo-name>/` automatically. For a custom subpath:

```bash
BASE_PATH=/my-path/ npm run build
```

## Embed mode

Append `?embed=1` to hide the page header — useful for iframe embeds in blog posts.

## Layout

```
src/
  explainer.ts     # Iceberg table ops + snapshot history
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
