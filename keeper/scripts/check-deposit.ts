import { providers } from "ethers";
import { ParentTransactionReceipt, ParentToChildMessageStatus } from "@arbitrum/sdk";
import { registerElysium } from "../src/networks.js";
const UA = { "user-agent": "curl/8.7.1" };
const elysium = new providers.StaticJsonRpcProvider({ url: "https://rpc.elysium.kinetiq.xyz", headers: UA }, 99901);
const hyperevm = new providers.StaticJsonRpcProvider({ url: "https://rpc.hyperliquid.xyz/evm", headers: UA }, 999);
registerElysium();
const deposit = "0x08f144798e53461195636dbc71d615f8b9b9e004baf4abf878755c5585060840";
const pr = new ParentTransactionReceipt(await hyperevm.getTransactionReceipt(deposit));
for (const m of await pr.getParentToChildMessages(elysium)) {
  console.log("ticket id:", m.retryableCreationId);
  const t0 = Date.now();
  const s = await m.status();
  console.log(`status: ${ParentToChildMessageStatus[s]} (${Date.now() - t0} ms)`);
}
