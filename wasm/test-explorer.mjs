import {
  fileCatalog,
  icebergAppend,
  icebergCreateTable,
  icebergDropTable,
  icebergManifests,
  icebergMetadata,
  icebergRead,
  icebergRewrite,
  loadLatestFileCatalogMetadata,
} from 'icebird'
import { ByteWriter } from 'hyparquet-writer'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'

const store = new Map()

function memoryResolver() {
  return {
    reader(path) {
      const bytes = store.get(path)
      if (!bytes) throw new Error(`missing: ${path}`)
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      return {
        byteLength: bytes.byteLength,
        slice(start, end = bytes.byteLength) {
          return buffer.slice(start, end)
        },
      }
    },
    writer(path) {
      const w = new ByteWriter()
      w.finish = async function () {
        store.set(path, w.getBytes())
      }
      return w
    },
    async deleter(path) {
      store.delete(path)
    },
  }
}

function memoryLister() {
  return async (dir) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    return [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
  }
}

const TABLE_URL = 'memory://warehouse/demo/events'
const resolver = memoryResolver()
const lister = memoryLister()
const catalog = fileCatalog({ resolver, lister })

const schema = {
  type: 'struct',
  'schema-id': 0,
  fields: [
    { id: 1, name: 'date', required: true, type: 'date' },
    { id: 2, name: 'state', required: true, type: 'string' },
    { id: 3, name: 'value', required: true, type: 'string' },
  ],
}

const partitionSpec = {
  'spec-id': 0,
  fields: [
    { 'source-id': 1, 'field-id': 1001, name: 'date_month', transform: 'month' },
    { 'source-id': 2, 'field-id': 1002, name: 'state_bucket_10', transform: 'bucket[10]' },
  ],
}

await icebergCreateTable({ catalog, tableUrl: TABLE_URL, schema, partitionSpec })
const empty = await loadLatestFileCatalogMetadata({ tableUrl: TABLE_URL, resolver, lister })
console.log('empty snapshot', empty.metadata['current-snapshot-id'])
try {
  await icebergRead({ tableUrl: TABLE_URL, metadata: empty.metadata, resolver, lister })
} catch (e) {
  console.log('read empty ok error:', e.message)
}
function isoToDays(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000)
}

await icebergAppend({
  catalog,
  tableUrl: TABLE_URL,
  records: [{ date: isoToDays('2026-07-16'), state: 'CA', value: 'hello' }],
})
await icebergAppend({
  catalog,
  tableUrl: TABLE_URL,
  records: [{ date: isoToDays('2026-07-20'), state: 'CA', value: 'world' }],
})

const { metadata, metadataLocation } = await loadLatestFileCatalogMetadata({
  tableUrl: TABLE_URL,
  resolver,
  lister,
})
const rows = await icebergRead({ tableUrl: TABLE_URL, metadata, resolver, lister })
console.log('rows', rows)

const manifests = await icebergManifests({ metadata, resolver })
console.log('manifest files', manifests.length, manifests[0]?.entries.length)

const path = manifests[0].entries[0].data_file.file_path
const bytes = store.get(path)
const meta = parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
console.log('parquet rows', meta.num_rows)
console.log('parquet stats col0', meta.row_groups[0].columns[0].meta_data.statistics)

await icebergRewrite({ catalog, tableUrl: TABLE_URL })
const after = await icebergMetadata({ tableUrl: TABLE_URL, resolver, lister })
console.log('snapshots after compact', after.snapshots?.length)
