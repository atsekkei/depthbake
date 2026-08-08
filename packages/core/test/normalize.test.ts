import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDisparity } from "../src/normalize.ts";

test("normalizeDisparity maps min to 0 and max to 1", () => {
  const { data, min, max } = normalizeDisparity([2, 5, 8]);
  assert.equal(min, 2);
  assert.equal(max, 8);
  assert.deepEqual([...data], [0, 0.5, 1]);
});

test("normalizeDisparity handles a constant input without dividing by zero", () => {
  const { data } = normalizeDisparity([3, 3, 3]);
  assert.deepEqual([...data], [0, 0, 0]);
});
