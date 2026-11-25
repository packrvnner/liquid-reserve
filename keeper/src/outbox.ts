// Elysium -> HyperEVM withdrawal claims, done with exact single-block lookups.
// (The Arbitrum SDK's status() scans hundreds of thousands of HyperEVM blocks
// for unconfirmed messages, which public HyperEVM RPCs reject: max 1,000 blocks.)
import { BigNumber, providers, Signer, utils, ContractTransaction } from "ethers";
import { BoldRollupUserLogic__factory } from "@arbitrum/sdk/dist/lib/abi-bold/factories/BoldRollupUserLogic__factory.js";
import { Outbox__factory } from "@arbitrum/sdk/dist/lib/abi/factories/Outbox__factory.js";
import { NodeInterface__factory } from "@arbitrum/sdk/dist/lib/abi/factories/NodeInterface__factory.js";
import { ArbSys__factory } from "@arbitrum/sdk/dist/lib/abi/factories/ArbSys__factory.js";
import { ELYSIUM_NETWORK } from "./networks.js";

const ARB_SYS = "0x0000000000000000000000000000000000000064";
const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
const arbSys = ArbSys__factory.createInterface();

/** One Elysium -> HyperEVM message (from an ArbSys L2ToL1Tx event). */
export interface Withdrawal {
  txHash: string;
  caller: string;
  destination: string;
  position: BigNumber;
  arbBlockNum: BigNumber;
  ethBlockNum: BigNumber;
  timestamp: BigNumber;
  callvalue: BigNumber;
  data: string;
}

export type WithdrawalState = "UNCONFIRMED" | "CONFIRMED" | "EXECUTED";

/** Withdrawals created by an Elysium transaction. */
export async function withdrawalsInTx(elysium: providers.Provider, txHash: string): Promise<Withdrawal[]> {
  const receipt = await elysium.getTransactionReceipt(txHash);
  if (!receipt) return [];
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === ARB_SYS && l.topics[0] === arbSys.getEventTopic("L2ToL1Tx"))
    .map((l) => {
      const e = arbSys.parseLog(l).args;
      return {
        txHash,
        caller: e.caller,
        destination: e.destination,
        position: e.position,
        arbBlockNum: e.arbBlockNum,
        ethBlockNum: e.ethBlockNum,
        timestamp: e.timestamp,
        callvalue: e.callvalue,
        data: e.data,
      };
    });
}

/** Number of Elysium -> HyperEVM messages covered by the latest confirmed assertion. */
export async function confirmedSendCount(
  hyperevm: providers.Provider,
  elysium: providers.JsonRpcProvider,
): Promise<{ sendCount: BigNumber; sendRoot: string }> {
  const rollup = BoldRollupUserLogic__factory.connect(ELYSIUM_NETWORK.ethBridge.rollup, hyperevm);
  const latest = await rollup.latestConfirmed();
  const created = (await rollup.getAssertion(latest)).createdAtBlock.toNumber();
  const logs = await hyperevm.getLogs({
    address: rollup.address,
    topics: rollup.filters.AssertionCreated(latest).topics,
    fromBlock: created,
    toBlock: created,
  });
  if (logs.length !== 1) throw new Error(`expected 1 AssertionCreated log at ${created}, got ${logs.length}`);
  const after = rollup.interface.parseLog(logs[0]).args.assertion.afterState.globalState;
  const [blockHash, sendRoot] = after.bytes32Vals as [string, string];
  const block = await elysium.send("eth_getBlockByHash", [blockHash, false]);
  if (!block) throw new Error(`Elysium block ${blockHash} not found`);
  if (block.sendRoot !== sendRoot) throw new Error("send root mismatch");
  return { sendCount: BigNumber.from(block.sendCount), sendRoot };
}

export async function withdrawalState(
  w: Withdrawal,
  hyperevm: providers.Provider,
  sendCount: BigNumber,
): Promise<WithdrawalState> {
  const outbox = Outbox__factory.connect(ELYSIUM_NETWORK.ethBridge.outbox, hyperevm);
  if (await outbox.isSpent(w.position)) return "EXECUTED";
  return w.position.lt(sendCount) ? "CONFIRMED" : "UNCONFIRMED";
}

/** Builds the outbox call for a confirmed withdrawal. */
export async function buildExecute(w: Withdrawal, elysium: providers.Provider, sendCount: BigNumber) {
  const nodeInterface = NodeInterface__factory.connect(NODE_INTERFACE, elysium);
  const { proof } = await nodeInterface.constructOutboxProof(sendCount.toNumber(), w.position.toNumber());
  const args = [
    proof,
    w.position,
    w.caller,
    w.destination,
    w.arbBlockNum,
    w.ethBlockNum,
    w.timestamp,
    w.callvalue,
    w.data,
  ] as const;
  return args;
}

export async function simulateExecute(
  w: Withdrawal,
  hyperevm: providers.Provider,
  elysium: providers.Provider,
  sendCount: BigNumber,
  from: string,
): Promise<void> {
  const outbox = Outbox__factory.connect(ELYSIUM_NETWORK.ethBridge.outbox, hyperevm);
  await outbox.callStatic.executeTransaction(...(await buildExecute(w, elysium, sendCount)), { from });
}

export async function execute(
  w: Withdrawal,
  signer: Signer,
  elysium: providers.Provider,
  sendCount: BigNumber,
): Promise<ContractTransaction> {
  const outbox = Outbox__factory.connect(ELYSIUM_NETWORK.ethBridge.outbox, signer);
  return outbox.executeTransaction(...(await buildExecute(w, elysium, sendCount)));
}

export const L2_TO_L1_TOPIC = arbSys.getEventTopic("L2ToL1Tx");
export { utils };
