// Read-only: measures the real confirmation lag and simulates claiming a
// confirmed Elysium -> HyperEVM withdrawal with our proof. Sends nothing.
import { providers } from "ethers";
import { confirmedSendCount, withdrawalsInTx, withdrawalState, simulateExecute, L2_TO_L1_TOPIC } from "../src/outbox.js";
const UA = { "user-agent": "curl/8.7.1" };
const elysium = new providers.StaticJsonRpcProvider({ url: "https://rpc.elysium.kinetiq.xyz", headers: UA }, 99901);
const hyperevm = new providers.StaticJsonRpcProvider({ url: "https://rpc.hyperliquid.xyz/evm", headers: UA }, 999);

const { sendCount } = await confirmedSendCount(hyperevm, elysium);
const latest = await elysium.getBlockNumber();
const logs = await elysium.getLogs({ address: "0x0000000000000000000000000000000000000064", topics: [L2_TO_L1_TOPIC], fromBlock: latest - 6_000_000, toBlock: latest });
const confirmed = logs.filter((l) => BigInt(l.topics[3]) < BigInt(sendCount.toString()));
const newest = confirmed[confirmed.length - 1];
const age = (Date.now() / 1000 - (await elysium.getBlock(newest.blockNumber)).timestamp) / 3600;
console.log(`confirmed sendCount ${sendCount}: newest confirmed withdrawal is ${age.toFixed(1)} h old`);

const counts: Record<string, number> = {};
let simulated = 0;
for (const l of confirmed.slice(-40).reverse()) {
  for (const w of await withdrawalsInTx(elysium, l.transactionHash)) {
    const s = await withdrawalState(w, hyperevm, sendCount);
    counts[s] = (counts[s] ?? 0) + 1;
    if (s === "CONFIRMED" && simulated < 2) {
      await simulateExecute(w, hyperevm, elysium, sendCount, "0x000000000000000000000000000000000000dEaD");
      console.log(`simulated claim OK: position ${w.position}, to ${w.destination}`);
      simulated++;
    }
  }
}
console.log("40 most recently confirmed:", counts);
