// A streaming PNG encoder. Rows go in top to bottom and are compressed as
// they arrive, so an image far larger than a browser canvas allows (or than
// memory would hold uncompressed) can still be written. The result is a Blob
// made of compressed pieces.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer>[] {
  const head = new Uint8Array(8);
  const view = new DataView(head.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, crc32([head.subarray(4), data]));
  return [head, new Uint8Array(data), tail];
}

export class PngWriter {
  private parts: BlobPart[] = [];
  private writer: WritableStreamDefaultWriter<BufferSource>;
  private drained: Promise<void>;
  private rowsWritten = 0;

  /** An 8-bit RGB image. */
  constructor(private width: number, private height: number) {
    this.parts.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width);
    v.setUint32(4, height);
    ihdr.set([8, 2, 0, 0, 0], 8); // bit depth 8, colour type RGB
    this.parts.push(...chunk("IHDR", ihdr));

    // PNG image data is a zlib stream, which is what "deflate" produces here.
    const stream = new CompressionStream("deflate");
    this.writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    this.drained = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.parts.push(...chunk("IDAT", value));
      }
    })();
  }

  /** Append rows from RGBA pixels (alpha is dropped). */
  async addRows(rgba: Uint8Array | Uint8ClampedArray, rows: number): Promise<void> {
    const w = this.width;
    const out = new Uint8Array(rows * (1 + w * 3));
    let o = 0;
    for (let r = 0; r < rows; r++) {
      out[o++] = 0; // filter: none
      let i = r * w * 4;
      for (let x = 0; x < w; x++, i += 4) {
        out[o++] = rgba[i];
        out[o++] = rgba[i + 1];
        out[o++] = rgba[i + 2];
      }
    }
    this.rowsWritten += rows;
    await this.writer.write(out);
  }

  async finish(): Promise<Blob> {
    if (this.rowsWritten !== this.height) throw new Error(`Expected ${this.height} rows, got ${this.rowsWritten}.`);
    await this.writer.close();
    await this.drained;
    this.parts.push(...chunk("IEND", new Uint8Array(0)));
    return new Blob(this.parts, { type: "image/png" });
  }

  async abort(): Promise<void> {
    await this.writer.abort().catch(() => {});
  }
}
