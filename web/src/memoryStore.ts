import type { Lister, Resolver } from 'icebird/src/types.js'
import { ByteWriter } from 'hyparquet-writer'

/** In-browser object store standing in for S3 / RustFS. */
export class MemoryObjectStore {
  private readonly files = new Map<string, Uint8Array>()

  clear(): void {
    this.files.clear()
  }

  resolver(): Resolver {
    const files = this.files
    return {
      reader(path: string) {
        const bytes = files.get(path)
        if (!bytes) throw new Error(`Object not found: ${path}`)
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer
        return {
          byteLength: bytes.byteLength,
          slice(start: number, end = bytes.byteLength) {
            return buffer.slice(start, end)
          },
        }
      },
      writer(path: string) {
        const w = new ByteWriter()
        w.finish = async function () {
          files.set(path, w.getBytes())
        }
        return w
      },
      async deleter(path: string) {
        files.delete(path)
      },
    }
  }

  lister(): Lister {
    const files = this.files
    return async (dir: string) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      return [...files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
    }
  }

  read(path: string): Uint8Array | undefined {
    return this.files.get(path)
  }
}
