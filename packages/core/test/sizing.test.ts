import test from "node:test";
import assert from "node:assert/strict";
import { nextMapMaxSize } from "../src/sizing.ts";

test("nextMapMaxSize estimates the next common edge from the byte ratio", () => {
  assert.equal(nextMapMaxSize(1000, 4_000_000, 1_000_000), 475);
});

test("nextMapMaxSize never grows and respects the minimum edge", () => {
  assert.equal(nextMapMaxSize(1024, 500_000, 1_000_000), 1024);
  assert.equal(nextMapMaxSize(100, 100_000_000, 1), 64);
  assert.equal(nextMapMaxSize(64, 100_000_000, 1), 64);
});
