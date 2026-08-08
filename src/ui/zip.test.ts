import { test } from "node:test";
import assert from "node:assert/strict";
import { createZip } from "./zip.ts";

function readLocalEntries(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: { name: string; data: Uint8Array }[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature !== 0x04034b50) break;
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    assert.equal(compressedSize, uncompressedSize, "STORE method must not compress");
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    const data = bytes.subarray(dataStart, dataStart + uncompressedSize);
    entries.push({ name, data: data.slice() });
    offset = dataStart + uncompressedSize;
  }
  return entries;
}

test("createZip round-trips file names and bytes via STORE (no compression)", async () => {
  const encoder = new TextEncoder();
  const files = [
    { name: "meta.json", data: encoder.encode('{"version":1}') },
    { name: "depth.png", data: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]) },
  ];
  const zip = createZip(files);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const entries = readLocalEntries(bytes);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "meta.json");
  assert.deepEqual([...entries[0].data], [...files[0].data]);
  assert.equal(entries[1].name, "depth.png");
  assert.deepEqual([...entries[1].data], [...files[1].data]);
});

test("createZip produces a valid end-of-central-directory record", async () => {
  const zip = createZip([{ name: "a.txt", data: new TextEncoder().encode("hello") }]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const eocdOffset = bytes.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  assert.equal(view.getUint16(eocdOffset + 10, true), 1); // total entries
});

test("createZip handles an empty entry list", async () => {
  const zip = createZip([]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.equal(bytes.length, 22); // EOCD only
});
