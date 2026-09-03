/**
 * Chrome Native Messaging wire protocol:
 * Each message is prefixed with a 4-byte little-endian uint32 length header,
 * followed by UTF-8 JSON payload.
 */

export function encodeMessage(obj: unknown): Buffer {
  const json = JSON.stringify(obj)
  const payload = Buffer.from(json, 'utf-8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  return Buffer.concat([header, payload])
}

export class NativeMessageReader {
  private buf = Buffer.alloc(0)
  private onMessage: (msg: unknown) => void

  constructor(onMessage: (msg: unknown) => void) {
    this.onMessage = onMessage
  }

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk])
    this.drain()
  }

  private drain(): void {
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0)
      if (this.buf.length < 4 + len) break
      const json = this.buf.subarray(4, 4 + len).toString('utf-8')
      this.buf = this.buf.subarray(4 + len)
      try {
        this.onMessage(JSON.parse(json))
      } catch {
        // skip malformed messages
      }
    }
  }
}
