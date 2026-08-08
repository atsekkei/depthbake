const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(v: number): void {
    this.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  }

  u32(v: number): void {
    this.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));
  }

  concat(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * 無圧縮(STORE方式)のZIPアーカイブを組み立てる。依存ライブラリなしで、
 * ブラウザ export 用に複数ファイルを1つのダウンロードへまとめるためだけに使う。
 * 画像データは既に圧縮済み(avif/png)なのでDEFLATEによる追加圧縮の恩恵は薄い。
 */
export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const GENERAL_PURPOSE_FLAG_UTF8 = 0x0800;

  const body = new ByteWriter();
  const central = new ByteWriter();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const localOffset = body.length;

    body.u32(0x04034b50);
    body.u16(20);
    body.u16(GENERAL_PURPOSE_FLAG_UTF8);
    body.u16(0); // method: store
    body.u16(time);
    body.u16(date);
    body.u32(crc);
    body.u32(entry.data.length);
    body.u32(entry.data.length);
    body.u16(nameBytes.length);
    body.u16(0); // extra field length
    body.push(nameBytes);
    body.push(entry.data);

    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed to extract
    central.u16(GENERAL_PURPOSE_FLAG_UTF8);
    central.u16(0); // method: store
    central.u16(time);
    central.u16(date);
    central.u32(crc);
    central.u32(entry.data.length);
    central.u32(entry.data.length);
    central.u16(nameBytes.length);
    central.u16(0); // extra field length
    central.u16(0); // comment length
    central.u16(0); // disk number start
    central.u16(0); // internal file attributes
    central.u32(0); // external file attributes
    central.u32(localOffset);
    central.push(nameBytes);
  }

  const centralOffset = body.length;
  const centralBytes = central.concat();

  const eocd = new ByteWriter();
  eocd.u32(0x06054b50);
  eocd.u16(0); // disk number
  eocd.u16(0); // disk where central directory starts
  eocd.u16(entries.length);
  eocd.u16(entries.length);
  eocd.u32(centralBytes.length);
  eocd.u32(centralOffset);
  eocd.u16(0); // comment length

  return new Blob([body.concat(), centralBytes, eocd.concat()], { type: "application/zip" });
}
