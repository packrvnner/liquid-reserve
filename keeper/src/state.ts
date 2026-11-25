import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface KeeperState {
  /** Elysium block up to which BridgeOut events were scanned. */
  elysiumScanBlock?: number;
  /** HyperEVM block up to which YieldUnstakeBridge events were scanned. */
  hyperevmScanBlock?: number;
  /** Elysium BridgeOut tx hash -> claim status on HyperEVM. */
  withdrawals: Record<string, "PENDING" | "EXECUTED">;
  /** HyperEVM bridge tx hash -> Elysium ticket status. */
  tickets: Record<string, "PENDING" | "REDEEMED" | "FAILED">;
  /** Highest sKNTQ withdrawal request id already confirmed (or found empty). */
  lastSettledRequestId: number;
  /** Remembered piece size per "contract:token" (decimal string). */
  chunks: Record<string, string>;
  /** Unix seconds each task last ran. */
  lastRun: Record<string, number>;
}

const EMPTY: KeeperState = { withdrawals: {}, tickets: {}, lastSettledRequestId: 0, chunks: {}, lastRun: {} };

export function loadState(file: string): KeeperState {
  if (!existsSync(file)) return structuredClone(EMPTY);
  return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(file, "utf8")) };
}

export function saveState(file: string, s: KeeperState) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file); // atomic replace
}
