import { BigNumber, Contract, providers, utils } from "ethers";
import * as abi from "./abis.js";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import type { KeeperState } from "./state.js";

export interface Ctx {
  cfg: Config;
  elysium: Chain;
  hyperevm?: Chain;
  keeper: string;
  state: KeeperState;
  e: Record<string, Contract | undefined>; // Elysium contracts
  h: Record<string, Contract | undefined>; // HyperEVM contracts
  tokens: { symbol: string; address: string; contract: Contract; decimals: number }[];
  feedIds?: string[];
}

const at = (addr: string | undefined, iface: string[], p: providers.Provider) =>
  addr ? new Contract(addr, iface, p) : undefined;

export async function buildCtx(cfg: Config, elysium: Chain, hyperevm: Chain | undefined, keeper: string, state: KeeperState): Promise<Ctx> {
  const ep = elysium.provider;
  const E = cfg.elysium;
  const e = {
    oracle: at(E.oracle, abi.ORACLE, ep),
    feeInbox: at(E.feeInbox, abi.FEE_INBOX, ep),
    feeRouter: at(E.feeRouter, abi.FEE_SPLITTER, ep),
    allocator: at(E.allocator, abi.ALLOCATOR, ep),
    creatorPayout: at(E.creatorPayout, abi.CREATOR_PAYOUT, ep),
    yieldRouter: at(E.yieldRouter, abi.YIELD_ROUTER, ep),
    reserve: at(E.reserve, abi.RESERVE, ep),
    bridgeOut: at(E.bridgeOut, abi.BRIDGE_OUT, ep),
    staking: at(E.staking, abi.STAKING, ep),
    escrow: at(E.ascendEscrow, abi.ASCEND_ESCROW, ep),
  };
  const h: Record<string, Contract | undefined> = {};
  if (hyperevm && cfg.hyperevm) {
    const hp = hyperevm.provider;
    const H = cfg.hyperevm;
    h.stakeAndLock = at(H.stakeAndLock, abi.STAKE_AND_LOCK, hp);
    h.reserve = at(H.reserve, abi.RESERVE, hp);
    h.yieldBridge = at(H.yieldUnstakeBridge, abi.YIELD_UNSTAKE_BRIDGE, hp);
    h.inbox = at(H.inbox, abi.INBOX, hp);
    if (h.yieldBridge) {
      h.vault = new Contract(await h.yieldBridge.vault(), abi.SKNTQ, hp);
      h.kntq = new Contract(await h.yieldBridge.asset(), abi.ERC20, hp);
    } else if (h.stakeAndLock) {
      h.kntq = new Contract(await h.stakeAndLock.asset(), abi.ERC20, hp);
    }
  }
  const tokens = await Promise.all(
    Object.entries(E.tokens).map(async ([symbol, address]) => {
      const contract = new Contract(address, abi.ERC20, ep);
      return { symbol, address, contract, decimals: await contract.decimals() };
    }),
  );
  return { cfg, elysium, hyperevm, keeper, state, e, h, tokens };
}

export const fmt = (v: BigNumber, decimals = 18) => {
  const s = utils.formatUnits(v, decimals);
  const [i, f = ""] = s.split(".");
  return f.length > 4 ? `${i}.${f.slice(0, 4)}` : s;
};

/** eth_getLogs in windows, for RPCs that cap the block range (HyperEVM: 1,000). */
export async function logsChunked(
  p: providers.Provider,
  filter: { address: string; topics?: (string | null)[] },
  from: number,
  to: number,
  step: number,
): Promise<providers.Log[]> {
  const out: providers.Log[] = [];
  for (let a = from; a <= to; a += step) {
    const b = Math.min(to, a + step - 1);
    out.push(...(await p.getLogs({ ...filter, fromBlock: a, toBlock: b } as any)));
  }
  return out;
}
