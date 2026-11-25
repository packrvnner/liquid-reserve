// DEV ONLY: a fake injected wallet for testing against a local anvil fork.
// app.js loads it only when the deployment's RPC is localhost AND the URL has
// ?devwallet=1. It forwards requests to anvil, which signs with its built-in,
// publicly known test accounts. Never active against a real network.
export async function installDevWallet(rpcUrl) {
  const call = async (method, params = []) => {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };
  const [account] = await call("eth_accounts");
  window.ethereum = {
    isDevWallet: true,
    on() {},
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      return call(method, params);
    },
  };
  console.info("[dev wallet] using anvil test account", account);
}
