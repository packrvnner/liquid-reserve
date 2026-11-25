// The creator's share, worded from what is true on-chain right now.
//
// What the creator receives:
// - 10% of $liquid's share of the trading fee, paid by Ascend straight to the creator's wallet (fixed at launch)
// - 20% of the fee cut of vaults whose fee address is the creator-share splitter (cfg.vaults[].feeTo).
//   Vaults opened before 17 November 2026 send their whole fee cut to the reserve, and that cannot change.
// - 20% of the reserve's yield, once the reserve's yield contract points at the yield splitter
//   (read from the chain in reserve.js: S.inbox.pre.yieldShare)
// The site states each of these only when it is in force.
import { flow } from "./flow.js";

const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

export function creatorShare(S) {
  const cs = S?.cfg?.elysium?.creatorShare;
  const paying = cs ? (S.cfg.vaults ?? []).filter((v) => same(v.feeTo, cs.vaultFeeSplit)) : [];
  return {
    /** the splitters are set up */
    set: !!cs,
    /** some vaults pay 20% of their fee cut to the creator */
    vaultFees: paying.length > 0,
    pays: (v) => !!cs && same(v?.feeTo, cs.vaultFeeSplit),
    /** 20% of the reserve's yield goes to the creator now */
    yieldLive: !!S?.inbox?.pre?.yieldShare,
  };
}

/** One sentence on vault fees. */
export const vaultFeeText = (S) => (creatorShare(S).vaultFees
  ? "Vaults opened since 17 November 2026 pay 20% of their fee cut to the creator and 80% to the reserve; vaults opened before that send all of it to the reserve."
  : "Vault fees go entirely to the reserve.");

/** One sentence on the creator's part of the reserve's yield. */
export function yieldText(S) {
  const c = creatorShare(S);
  // Until the chain has answered, what the settings name is taken to be in force (the yield splitter was set for good on 19 November 2026).
  if (c.yieldLive || (c.set && !S?.inbox)) {
    return flow(S).yieldOn
      ? "The creator's wallet also receives 20% of the reserve's yield, through a splitter that cannot be changed; the other 80% is divided by the yield director, in shares the owner sets and can change."
      : "The creator's wallet also receives 20% of the reserve's yield, through a splitter that cannot be changed; the other 80% is held until the rest of the yield plan is built.";
  }
  if (c.set) return "The creator's wallet is also set to receive 20% of the reserve's yield; that takes effect through the 48-hour timelock.";
  return "Once the yield waterfall is built the creator will also receive 20% of reserve yield, paid to a fixed address that only that address can change.";
}
