import { providers, Signer, VoidSigner, Wallet } from "ethers";
import type { Config } from "./config.js";
import { ELYSIUM_CHAIN_ID, HYPEREVM_CHAIN_ID } from "./networks.js";

const HEADERS = { "user-agent": "liquid-reserve-keeper/0.1" };

export interface Chain {
  name: "Elysium" | "HyperEVM";
  provider: providers.StaticJsonRpcProvider;
  signer: Signer;
  /** HyperEVM small blocks only fit ~2M gas; bigger txs need big blocks. */
  maxGasPerTx?: number;
}

export async function connect(cfg: Config): Promise<{ elysium: Chain; hyperevm?: Chain; keeper: string }> {
  const mk = (url: string) => new providers.StaticJsonRpcProvider({ url, headers: HEADERS });
  const ep = mk(cfg.elysium.rpc);
  const eId = (await ep.getNetwork()).chainId;
  if (eId !== ELYSIUM_CHAIN_ID) throw new Error(`Elysium RPC reports chain ${eId}, expected ${ELYSIUM_CHAIN_ID}`);
  const signerFor = (p: providers.Provider): Signer =>
    cfg.privateKey ? new Wallet(cfg.privateKey, p) : new VoidSigner(cfg.keeperAddress!, p);

  const elysium: Chain = { name: "Elysium", provider: ep, signer: signerFor(ep) };
  let hyperevm: Chain | undefined;
  if (cfg.hyperevm) {
    const hp = mk(cfg.hyperevm.rpc);
    const hId = (await hp.getNetwork()).chainId;
    if (hId !== HYPEREVM_CHAIN_ID) throw new Error(`HyperEVM RPC reports chain ${hId}, expected ${HYPEREVM_CHAIN_ID}`);
    hyperevm = { name: "HyperEVM", provider: hp, signer: signerFor(hp), maxGasPerTx: 2_000_000 };
  }
  return { elysium, hyperevm, keeper: await elysium.signer.getAddress() };
}
