/* ZIP32 writer: UTF-8 names, CRC32, native raw DEFLATE with STORE fallback.
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * https://compression.spec.whatwg.org/
 * Entries are read one at a time; retain compressed Blobs, not every snapshot.
 */
const zipCRCTable = Uint32Array.from({length: 256}, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function zipCRC32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ zipCRCTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

class SnapshotZip {
  constructor() {
    this.parts = [];
    this.directory = [];
    this.names = new Set();
    this.offset = 0;
    this.directorySize = 0;
  }
  async addJSON(name, value) {
    if (!name || name.startsWith("/") || name.includes("\\") || name.includes(":") ||
        name.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f]/.test(name)) {
      throw new Error("采集包文件名无效。");
    }
    if (this.names.has(name)) throw new Error("采集包文件名重复。");
    if (this.names.size >= 65534) throw new Error("ZIP 文件数量过多，未生成不完整采集包。");
    const filename = new TextEncoder().encode(name);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (filename.length > 65535 || bytes.length >= 0xffffffff) throw new Error("ZIP 文件超出大小限制。");
    let body = new Blob([bytes]), method = 0, compressor;
    try { compressor = new CompressionStream("deflate-raw"); }
    catch (error) {
      // Older browsers can still download one valid ZIP without compression.
      if (!(error instanceof TypeError || error instanceof ReferenceError)) throw error;
    }
    if (compressor) {
      const compressed = await new Response(body.stream().pipeThrough(compressor)).blob();
      if (compressed.size < body.size) { body = compressed; method = 8; }
    }
    const nextOffset = this.offset + 30 + filename.length + body.size;
    const nextDirectorySize = this.directorySize + 46 + filename.length;
    if (nextOffset + nextDirectorySize + 22 >= 0xffffffff) throw new Error("采集包超过 ZIP32 大小限制，本机任务仍保留。");
    const crc = zipCRC32(bytes);
    const local = new Uint8Array(30), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true); l.setUint16(8, method, true);
    l.setUint16(12, 33, true); // DOS date: 1980-01-01, reproducible archive.
    l.setUint32(14, crc, true); l.setUint32(18, body.size, true);
    l.setUint32(22, bytes.length, true); l.setUint16(26, filename.length, true);
    const central = new Uint8Array(46), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true); c.setUint16(10, method, true); c.setUint16(14, 33, true);
    c.setUint32(16, crc, true); c.setUint32(20, body.size, true);
    c.setUint32(24, bytes.length, true); c.setUint16(28, filename.length, true);
    c.setUint32(42, this.offset, true);
    this.parts.push(local, filename, body);
    this.directory.push(central, filename);
    this.names.add(name); this.offset = nextOffset; this.directorySize = nextDirectorySize;
  }
  finish() {
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, this.names.size, true); e.setUint16(10, this.names.size, true);
    e.setUint32(12, this.directorySize, true); e.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.directory, end], {type: "application/zip"});
  }
}
