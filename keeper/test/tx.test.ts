import { test } from "node:test";
import assert from "node:assert/strict";
import { utils } from "ethers";
import { classify, decodeError } from "../src/tx.js";
import { ERRORS } from "../src/abis.js";

const iface = new utils.Interface(ERRORS);
// ethers v5 nests revert data differently per provider; mimic the common shapes.
const nested = (data: string) => ({ code: "CALL_EXCEPTION", error: { error: { data } } });
const inBody = (data: string) => ({ code: "SERVER_ERROR", body: JSON.stringify({ error: { code: 3, data } }) });

test("nothing-to-do reverts are classified quietly", () => {
  const o = classify(nested(iface.encodeErrorResult("NothingToAllocate", [])));
  assert.equal(o.kind, "nothing");
});

test("slippage reverts are price outcomes, with decoded arguments", () => {
  const data = iface.encodeErrorResult("InsufficientOutput", [100, 200]);
  const o = classify(inBody(data));
  assert.equal(o.kind, "price");
  assert.match(decodeError(inBody(data)).text, /InsufficientOutput\(100, 200\)/);
});

test("stale oracle and short history are price outcomes", () => {
  assert.equal(classify(nested(iface.encodeErrorResult("StalePrice", [utils.hexZeroPad("0x01", 32)]))).kind, "price");
  assert.equal(classify(nested(iface.encodeErrorResult("InsufficientHistory", [utils.hexZeroPad("0x01", 32)]))).kind, "price");
});

test("access errors and unknown reverts are failures", () => {
  assert.equal(classify(nested(iface.encodeErrorResult("NotKeeper", []))).kind, "failed");
  assert.equal(classify(nested("0xdeadbeef")).kind, "failed");
  assert.equal(classify(new Error("network down")).kind, "failed");
});

test("panics are decoded", () => {
  const data = "0x4e487b71" + utils.defaultAbiCoder.encode(["uint256"], [0x11]).slice(2);
  assert.match(decodeError(nested(data)).text, /Panic\(0x11\)/);
});

test("require strings are decoded", () => {
  const data = "0x08c379a0" + utils.defaultAbiCoder.encode(["string"], ["not ready"]).slice(2);
  assert.match(decodeError(nested(data)).text, /not ready/);
});

test("Uniswap v4 hook reverts are unwrapped and treated as price outcomes", () => {
  const inner = "0x08c379a0" + utils.defaultAbiCoder.encode(["string"], ["max trade"]).slice(2);
  const data = iface.encodeErrorResult("WrappedError", ["0x8129bab872318a64B0e6212C6C491feED06C3de3", "0x575e24b4", inner, "0x"]);
  const o = classify(nested(data));
  assert.equal(o.kind, "price");
  assert.match(decodeError(nested(data)).text, /hook 0x8129.*refused \(Error: max trade\)/);
});
