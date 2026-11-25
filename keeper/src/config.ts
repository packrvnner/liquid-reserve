import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ElysiumConfig {
  rpc: string;
  deployBlock: number;
  oracle?: string;
  feeInbox?: string;
  feeRouter?: string;
  allocator?: string;
  creatorPayout?: string;
  yieldRouter?: string;
  reserve?: string;
  bridgeOut?: string;
  staking?: string;
  ascendEscrow?: string; // $liquid's CreatorEscrow (from Ascend's EscrowLaunched event)
  vaults?: string[]; // LiquidityVault addresses to harvest
  tokens: Record<string, string>; // symbol -> address, every token that can flow through
}

export interface HyperEvmConfig {
  rpc: string;
  deployBlock: number;
  stakeAndLock?: string;
  reserve?: string;
  yieldUnstakeBridge?: string;
  inbox: string;
  minYieldToHarvest: string; // KNTQ, decimal string
}

export interface Tuning {
  pokeEverySec: number;
  processEverySec: number;
  bridgeEverySec: number;
  harvestEverySec: number;
  hyperevmEverySec: number;
  ticketsEverySec: number;
  vaultHarvestEverySec: number;
  /** Most ticks the pool may move between the keeper reading the price and its rebalance landing (20 ≈ 0.2%). */
  vaultMaxDriftTicks: number;
  minGasBalance: string; // HYPE, decimal string; warn below this
}

export interface Config {
  elysium: ElysiumConfig;
  hyperevm?: HyperEvmConfig;
  tuning: Tuning;
  dryRun: boolean;
  privateKey?: string;
  keeperAddress?: string;
  stateFile: string;
  alertWebhook?: string;
}

const DEFAULT_TUNING: Tuning = {
  pokeEverySec: 60,
  processEverySec: 600,
  bridgeEverySec: 3600,
  harvestEverySec: 86_400,
  hyperevmEverySec: 3600,
  ticketsEverySec: 900,
  vaultHarvestEverySec: 6 * 3600,
  vaultMaxDriftTicks: 20,
  minGasBalance: "0.05",
};

export function loadConfig(argv = process.argv): Config {
  const file = resolve(process.env.KEEPER_CONFIG ?? "keeper.config.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const dryRun = process.env.DRY_RUN === "1" || argv.includes("--dry-run");
  const privateKey = process.env.KEEPER_PRIVATE_KEY || undefined;
  const keeperAddress = process.env.KEEPER_ADDRESS || undefined;
  if (!dryRun && !privateKey) throw new Error("KEEPER_PRIVATE_KEY is required (or run with DRY_RUN=1 and KEEPER_ADDRESS)");
  if (dryRun && !privateKey && !keeperAddress) throw new Error("dry run needs KEEPER_ADDRESS (or KEEPER_PRIVATE_KEY)");
  return {
    elysium: { deployBlock: 0, ...raw.elysium, rpc: process.env.ELYSIUM_RPC || raw.elysium.rpc },
    hyperevm: raw.hyperevm
      ? { deployBlock: 0, minYieldToHarvest: "10", ...raw.hyperevm, rpc: process.env.HYPEREVM_RPC || raw.hyperevm.rpc }
      : undefined,
    tuning: { ...DEFAULT_TUNING, ...(raw.tuning ?? {}) },
    dryRun,
    privateKey,
    keeperAddress,
    stateFile: resolve(process.env.KEEPER_STATE ?? "keeper.state.json"),
    alertWebhook: process.env.ALERT_WEBHOOK_URL,
  };
}
