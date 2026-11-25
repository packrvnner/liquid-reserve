// Read-only: prints the tx hash of a real confirmed-but-unclaimed Elysium -> HyperEVM withdrawal.
import { providers } from "ethers";
import { confirmedSendCount, withdrawalsInTx, withdrawalState, L2_TO_L1_TOPIC } from "../src/outbox.js";
const H = { "user-agent": "liquid-reserve-keeper/0.1" };
const elysium = new providers.StaticJsonRpcProvider({ url: "https://rpc.elysium.kinetiq.xyz", headers: H }, 99901);
const hyperevm = new providers.StaticJsonRpcProvider({ url: "https://rpc.hyperliquid.xyz/evm", headers: H }, 999);
const { sendCount } = await confirmedSendCount(hyperevm, elysium);
const latest = await elysium.getBlockNumber();
const logs = await elysium.getLogs({ address: "0x0000000000000000000000000000000000000064", topics: [L2_TO_L1_TOPIC], fromBlock: latest - 6_000_000, toBlock: latest });
for (const l of logs.filter((x) => BigInt(x.topics[3]) < BigInt(sendCount.toString())).reverse()) {
  for (const w of await withdrawalsInTx(elysium, l.transactionHash)) {
    if ((await withdrawalState(w, hyperevm, sendCount)) === "CONFIRMED") {
      console.log(l.transactionHash);
      process.exit(0);
    }
  }
}
