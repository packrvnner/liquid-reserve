// Runs the KNTQ staking job once against the REAL networks, without a wallet: it only reads and reports.
//   npx tsx hosted/watch-kntq.ts      (from keeper/)
// No key is read or needed here. Use it to see what the hosted job sees.
import { Wallet, utils } from "ethers";
import { runKntq } from "./kntq.js";

const out = await runKntq({ ethers: { Wallet, utils }, fetch, env: () => undefined }, null);
console.log(JSON.stringify(out.report, null, 2));
console.log("state:", JSON.stringify(out.state));
