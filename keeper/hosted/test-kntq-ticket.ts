// Checks the KNTQ job's bridge-ticket maths (ticketId / ticketIdsOf in kntq.ts) against REAL tickets: every token
// that crosses from HyperEVM to Elysium makes one, so recent ones by other people are used. Read-only, no wallet.
//   npx tsx hosted/test-kntq-ticket.ts      (from keeper/)
//   HYPEREVM_RPC=<url> ...                  another HyperEVM endpoint, if the public one is rate limiting
import { utils } from "ethers";
import { ticketId, ticketIdsOf, KNTQ_CONFIG } from "./kntq.js";

const E_RPC = KNTQ_CONFIG.elysium.rpc, H_RPC = process.env.HYPEREVM_RPC || KNTQ_CONFIG.hyperevm.rpc;
const RETRY = "0x000000000000000000000000000000000000006e";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(url: string, method: string, params: unknown[], tries = 0): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await res.json();
  if (j.error) {
    if (/rate limit|too many/i.test(j.error.message ?? "") && tries < 6) { await sleep(5000); return rpc(url, method, params, tries + 1); }
    throw Object.assign(new Error(j.error.message ?? "RPC error"), { rpcError: j.error });
  }
  return j.result;
}
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };

const created = utils.id("TicketCreated(bytes32)"), delivered = utils.id("InboxMessageDelivered(uint256,bytes)");
const tip = Number(await rpc(E_RPC, "eth_blockNumber", []));
const logs: any[] = [];
for (let lo = tip - 1_500_000; lo <= tip; lo += 500_000) logs.push(...await rpc(E_RPC, "eth_getLogs", [{ address: RETRY, topics: [created], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + Math.min(lo + 499_999, tip).toString(16) }]));
console.log(`${logs.length} tickets were created on Elysium in the last 1,500,000 blocks; checking the latest ${Math.min(logs.length, 6)}`);
check("there are real tickets to check against", logs.length > 0);

const getTimeout = new utils.Interface(["function getTimeout(bytes32) view returns (uint256)"]);
let viaL1 = 0;
for (const l of logs.slice(-6)) {
  const id = l.topics[1];
  const t = await rpc(E_RPC, "eth_getTransactionByHash", [id]);
  console.log(`ticket ${id}`);
  // 1. the id from the ticket's own fields, as Elysium reports them
  check("id from the ticket's fields", ticketId(utils, t) === id, `type ${t.type}, message ${Number(t.requestId)}`);
  // 2. the id from the HyperEVM transaction that created it: what the job has to go on
  const r = await rpc(E_RPC, "eth_getTransactionReceipt", [id]);
  const l1 = Number(r.l1BlockNumber);
  try {
    const sent = await rpc(H_RPC, "eth_getLogs", [{ address: KNTQ_CONFIG.hyperevm.inbox, topics: [delivered, t.requestId], fromBlock: "0x" + (l1 - 900).toString(16), toBlock: "0x" + (l1 + 50).toString(16) }]);
    if (sent.length !== 1) { console.log(`       (its HyperEVM transaction was not found near block ${l1}: ${sent.length} logs)`); }
    else {
      await sleep(800);
      const receipt = await rpc(H_RPC, "eth_getTransactionReceipt", [sent[0].transactionHash]);
      const ids = ticketIdsOf(utils, receipt, KNTQ_CONFIG.hyperevm.inbox, KNTQ_CONFIG.hyperevm.bridge, KNTQ_CONFIG.elysium.chainId);
      check("id from the HyperEVM transaction's logs", ids.includes(id), `tx ${sent[0].transactionHash.slice(0, 12)}…, ${ids.length} ticket(s)`);
      viaL1++;
    }
  } catch (e: any) { console.log(`       (HyperEVM lookup failed: ${String(e.message).slice(0, 80)})`); }
  // 3. a ticket that has run is gone: asking for it reverts, which is how the job tells
  if (r.status === "0x1") {
    let gone = false, msg = "";
    try { await rpc(E_RPC, "eth_call", [{ to: RETRY, data: getTimeout.encodeFunctionData("getTimeout", [id]) }, "latest"]); } catch (e: any) { msg = String(e.message); gone = /revert/i.test(msg); }
    check("a ticket that ran reads as gone", gone, msg.slice(0, 60));
  }
  await sleep(800);
}
check("at least one ticket was traced from its HyperEVM transaction", viaL1 > 0, `${viaL1} traced`);
// a ticket that does not exist must not read as "ran": the job looks for the ticket's own transaction first
check("an unknown ticket has no transaction on Elysium", (await rpc(E_RPC, "eth_getTransactionReceipt", ["0x" + "12".repeat(32)])) === null);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
