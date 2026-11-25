import { BigNumber, Contract, ContractReceipt, utils } from "ethers";
import { ERRORS } from "./abis.js";
import type { Chain } from "./chain.js";
import { info, warn, error } from "./log.js";

const errorIface = new utils.Interface(ERRORS);

/** Reverts that just mean "nothing to do right now". */
const NOTHING = new Set([
  "NothingToAllocate", "NothingToRoute", "NothingToPay", "NothingToDistribute", "NothingToForward",
  "NothingToStake", "NothingToUnstake", "NothingToBridge", "BelowMinimum", "ZeroAmount",
]);
/** Reverts that mean "price/liquidity not right yet": shrink the amount or wait.
 *  A pool hook refusing a swap (WrappedError) is often size-related too. */
const PRICE = new Set([
  "InsufficientOutput", "QuoteZero", "PartialFill", "StalePrice", "InsufficientHistory", "UnexpectedDelta",
  "WrappedError", "NotCalm",
]);

export type Outcome =
  | { kind: "sent"; receipt: ContractReceipt }
  | { kind: "dry" }
  | { kind: "nothing"; reason: string }
  | { kind: "price"; reason: string }
  | { kind: "failed"; reason: string };

export let DRY_RUN = false;
export function setDryRun(v: boolean) {
  DRY_RUN = v;
}

/** Finds revert data anywhere inside an ethers v5 error. */
function revertData(e: any, depth = 0): string | undefined {
  if (!e || depth > 5) return undefined;
  for (const k of ["data", "error", "body"]) {
    const v = e[k];
    if (typeof v === "string" && /^0x[0-9a-fA-F]{8}/.test(v)) return v;
    if (k === "body" && typeof v === "string") {
      try {
        const d = revertData(JSON.parse(v), depth + 1);
        if (d) return d;
      } catch {}
    }
    if (v && typeof v === "object") {
      const d = revertData(v, depth + 1);
      if (d) return d;
    }
  }
  return undefined;
}

export function decodeError(e: any): { name: string; text: string } {
  return decodeData(revertData(e), e);
}

function decodeData(data: string | undefined, e?: any): { name: string; text: string } {
  if (data && data.startsWith("0x08c379a0")) {
    const [reason] = utils.defaultAbiCoder.decode(["string"], "0x" + data.slice(10));
    return { name: "Error", text: `Error: ${reason}` };
  }
  if (data && data.startsWith("0x4e487b71")) {
    const [code] = utils.defaultAbiCoder.decode(["uint256"], "0x" + data.slice(10));
    return { name: "Panic", text: `Panic(0x${code.toHexString().slice(2)})` };
  }
  if (data) {
    try {
      const parsed = errorIface.parseError(data);
      if (parsed.name === "WrappedError") {
        const inner = decodeData(parsed.args.reason === "0x" ? undefined : parsed.args.reason);
        return { name: "WrappedError", text: `hook ${parsed.args.target} refused (${inner.text})` };
      }
      const args = parsed.args.map((a: any) => (BigNumber.isBigNumber(a) ? a.toString() : String(a))).join(", ");
      return { name: parsed.name, text: `${parsed.name}(${args})` };
    } catch {
      return { name: "unknown", text: `revert ${data.slice(0, 10)}` };
    }
  }
  if (!e) return { name: "unknown", text: "empty revert" };
  const msg = e?.reason ?? e?.error?.message ?? e?.message ?? String(e);
  return { name: "unknown", text: String(msg).split("\n")[0].slice(0, 200) };
}

export function classify(e: any): Outcome {
  const { name, text } = decodeError(e);
  if (NOTHING.has(name)) return { kind: "nothing", reason: text };
  if (PRICE.has(name) || /slippage/i.test(text)) return { kind: "price", reason: text };
  return { kind: "failed", reason: text };
}

/**
 * Simulates a call, then (unless dry-running) sends it. Expected "nothing to do"
 * reverts are quiet; price reverts are reported to the caller to adjust size.
 */
export async function act(
  chain: Chain,
  label: string,
  contract: Contract,
  method: string,
  args: unknown[] = [],
  value?: BigNumber,
): Promise<Outcome> {
  const c = contract.connect(chain.signer);
  const overrides: Record<string, unknown> = value ? { value } : {};
  try {
    await c.callStatic[method](...args, overrides);
  } catch (e) {
    const o = classify(e);
    if (o.kind === "failed") warn(`[${chain.name}] ${label}: would revert: ${o.reason}`);
    return o;
  }
  if (DRY_RUN) {
    info(`[${chain.name}] ${label}: OK in simulation (dry run, not sent)`);
    return { kind: "dry" };
  }
  try {
    const est = await c.estimateGas[method](...args, overrides);
    const gasLimit = est.mul(125).div(100);
    if (chain.maxGasPerTx && gasLimit.gt(chain.maxGasPerTx)) {
      warn(`[${chain.name}] ${label}: needs ${gasLimit} gas, above the ${chain.maxGasPerTx} small-block limit`);
    }
    const tx = await c[method](...args, { ...overrides, gasLimit });
    const receipt: ContractReceipt = await tx.wait(1);
    info(`[${chain.name}] ${label}: sent ${receipt.transactionHash} (gas ${receipt.gasUsed})`);
    return { kind: "sent", receipt };
  } catch (e) {
    const o = classify(e);
    error(`[${chain.name}] ${label}: send failed: ${o.kind === "failed" ? o.reason : o.kind}`);
    return { kind: "failed", reason: o.kind === "failed" ? o.reason : o.kind };
  }
}
