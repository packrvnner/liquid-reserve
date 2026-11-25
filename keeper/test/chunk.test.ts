import { test } from "node:test";
import assert from "node:assert/strict";
import { afterSuccess, firstTry, shrink, MIN_FRACTION } from "../src/chunk.js";

test("first try is the whole balance, or the remembered size capped at the balance", () => {
  assert.equal(firstTry(undefined, 1000n), 1000n);
  assert.equal(firstTry(200n, 1000n), 200n);
  assert.equal(firstTry(5000n, 1000n), 1000n);
  assert.equal(firstTry(200n, 0n), 0n);
});

test("shrink halves until balance/64, then gives up for this tick", () => {
  const bal = 6400n;
  const seen: bigint[] = [];
  let a: bigint | undefined = bal;
  while (a !== undefined) {
    seen.push(a);
    a = shrink(a, bal);
  }
  assert.deepEqual(seen, [6400n, 3200n, 1600n, 800n, 400n, 200n, 100n]);
  assert.equal(seen.at(-1), bal / MIN_FRACTION);
});

test("after a success the remembered size doubles", () => {
  assert.equal(afterSuccess(100n), 200n);
});
