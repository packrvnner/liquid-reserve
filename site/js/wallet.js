// Minimal EIP-1193 wallet connection (any injected wallet), no libraries.
import { short } from "./format.js";

const ELYSIUM = "0x1863d"; // 99901

export const wallet = {
  account: null,
  chainId: null,
  cfg: null,
  onChange: () => {},

  init(cfg, onChange) {
    this.cfg = cfg;
    this.onChange = onChange;
    const btn = document.getElementById("connect");
    btn.addEventListener("click", () => (this.account ? this.disconnect() : this.connect()));
    const eth = window.ethereum;
    if (!eth) return;
    eth.on?.("accountsChanged", (a) => { this.account = a[0] ?? null; this.paint(); this.onChange(); });
    eth.on?.("chainChanged", (c) => { this.chainId = c; this.onChange(); });
    eth.request({ method: "eth_accounts" }).then((a) => { if (a[0]) { this.account = a[0]; this.paint(); this.onChange(); } }).catch(() => {});
  },

  paint() {
    const btn = document.getElementById("connect");
    btn.textContent = this.account ? short(this.account) : "Connect wallet";
    btn.title = this.account ? "Click to disconnect" : "";
  },

  async connect() {
    const eth = window.ethereum;
    if (!eth) {
      alertBox("No browser wallet found. Install one (e.g. Rabby or MetaMask) to deposit into vaults.");
      return;
    }
    const [a] = await eth.request({ method: "eth_requestAccounts" });
    this.account = a ?? null;
    this.paint();
    await this.ensureChain().catch(() => {});
    this.onChange();
  },

  disconnect() {
    this.account = null;
    this.paint();
    this.onChange();
  },

  async ensureChain() {
    const eth = window.ethereum;
    this.chainId = await eth.request({ method: "eth_chainId" });
    if (this.chainId === ELYSIUM) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ELYSIUM }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: ELYSIUM,
          chainName: "Elysium",
          nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
          rpcUrls: [this.cfg.elysium.rpc],
          blockExplorerUrls: [this.cfg.elysium.explorer],
        }],
      });
    }
    this.chainId = ELYSIUM;
  },

  /** Sends a transaction on Elysium and waits for it to be mined. With `pad` (a percentage) the gas limit is the
   *  network's own estimate plus that margin, for calls whose cost moves a little from block to block (a swap through
   *  a pool with a hook); unused gas is not charged. Without it, or if the estimate fails, the wallet picks the limit. */
  async send(to, data, rpc, value = 0n, pad = 0) {
    if (!this.account) await this.connect();
    if (!this.account) throw new Error("Wallet not connected");
    await this.ensureChain();
    const tx = { from: this.account, to, data };
    if (value > 0n) tx.value = "0x" + value.toString(16);
    if (pad > 0) {
      const est = await rpc.request("eth_estimateGas", [tx]).catch(() => null);
      if (est) tx.gas = "0x" + ((BigInt(est) * BigInt(100 + pad)) / 100n).toString(16);
    }
    const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [tx] });
    for (let i = 0; i < 120; i++) {
      const r = await rpc.request("eth_getTransactionReceipt", [hash]);
      if (r) {
        if (r.status !== "0x1") throw new Error(`Transaction failed: ${hash}`);
        return hash;
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error(`Timed out waiting for ${hash}`);
  },
};

function alertBox(text) {
  const el = document.createElement("div");
  el.className = "msg err";
  el.style.cssText = "position:fixed;right:20px;bottom:20px;max-width:360px;z-index:50";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
