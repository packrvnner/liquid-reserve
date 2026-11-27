// Docs: short, plain pages. Content lives here so the site needs no build step.
import { esc, eyebrow, explorer, X_URL, X_HANDLE, icons, mark } from "./ui.js";
import { isLaunched } from "./data.js";
import { creatorShare, vaultFeeText, yieldText } from "./creator.js";
import { BANDS } from "./analytics.js";
import { short, amount } from "./format.js";
import { flow, share } from "./flow.js";

// The public code repository: contracts, tests, deployment records, bot and site code.
const REPO_URL = "https://github.com/packrvnner/liquid-reserve";

const up = (x) => x.charAt(0).toUpperCase() + x.slice(1);

const t = (head, rows, numCols = []) =>
  `<div class="tablewrap"><table class="data"><tr>${head.map((h, i) => `<th class="${numCols.includes(i) ? "n" : ""}">${h}</th>`).join("")}</tr>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${numCols.includes(i) ? "n" : ""}">${c}</td>`).join("")}</tr>`)
    .join("")}</table></div>`;

const PAGES = [
  {
    group: "Start here", slug: "overview", title: "Overview",
    html: (S, fl = flow(S)) => `<p class="lead">Liquid Reserve is a token, <b>$liquid</b>, with a reserve behind it that can never be withdrawn. Every trade pays a fee, part of that fee is locked in the reserve for good, and only the reserve's yield ever leaves.</p>
      <h2>The idea in four lines</h2>
      <ul>
        <li><b>Trade.</b> $liquid trades against HYPE on Ascend, Elysium's launchpad, with a 2% fee.</li>
        <li><b>Lock.</b> 40% of $liquid's share of that fee goes to the Locked Reserve's fee contract. ${fl.full ? "Nine tenths of it become staked HYPE, locked for good. One tenth buys $liquid for the drop." : `Of that, ${fl.splitText}.`}</li>
        <li><b>Earn.</b> The reserve earns staking yield. Principal stays; only yield can leave.</li>
        <li><b>Divide.</b> A fifth of the yield goes to the creator. ${fl.yieldOn ? `The rest is divided by shares the owner sets${fl.yieldUses ? `: today between ${esc(fl.yieldUses)}` : ""}.` : "The rest is held until its split is in force."}</li>
      </ul>
      <h2>What makes it different</h2>
      <ul>
        <li><b>No one can withdraw the reserve.</b> Not holders, not the team. The contract has no owner and no withdraw function, and it can't be upgraded.</li>
        <li><b>Nothing is printed.</b> Every payout comes from trading fees or staking yield.</li>
        <li><b>Everything is on-chain and public.</b> The <a href="#/analytics">analytics</a> page reads the contracts directly from your browser.</li>
      </ul>
      <div class="callout warn"><p><b>Status:</b> $liquid is live on Ascend, and the locked reserve and the vaults are live on Elysium and HyperEVM. ${fl.full && fl.yieldOn ? `Since ${esc(fl.since)} the reserve takes in staked HYPE only, the drop is being filled and the yield is divided by shares.` : "The yield split is not in force yet."} None of the contracts have been <b>audited</b>. See <a href="#/docs/security">Security and status</a>.</p></div>`,
  },
  {
    group: "Start here", slug: "token", title: "$liquid and the fee",
    html: (S, fl = flow(S)) => `<p class="lead">$liquid launched on <b>Ascend</b>, the launchpad on Elysium, paired with <b>HYPE</b>. Ascend created the token and its pool; Liquid Reserve builds everything the fee flows into.</p>
      <h2>Token facts</h2>
      ${t(["", ""], [["Name", "Liquid Reserve"], ["Ticker", "$liquid"], ["Supply", "1,000,000,000, fixed (Ascend standard)"], ["Pair", "HYPE"], ["Trading fee", "2% on buys and sells, paid in HYPE"], ["Launch liquidity", "Locked by Ascend"]])}
      <h2>How the 2% is split</h2>
      <p>Ascend takes its cut from the first 1%. Everything above it is $liquid's share of the fee, which Ascend calls the <b>creator allocation</b>. Despite the name, only a tenth of it goes to the creator (see below). Ascend's share shrinks as market cap grows:</p>
      ${t(["Market cap (moving average)", "Creator allocation", "Ascend coin support", "Ascend protocol"], BANDS.map((b) => [b.name, `${((0.01 + b.creator) * 100).toFixed(2)}%`, b.support ? `${(b.support * 100).toFixed(2)}%` : "—", `${(b.protocol * 100).toFixed(2)}%`]), [1, 2, 3])}
      <p>The creator allocation is routed by settings fixed at launch:</p>
      ${t(["Share", "Goes to"], [["25%", "Holder rewards, distributed by Ascend"], ["25%", "Buy and burn $liquid, by Ascend"], ["50%", `Paid out: 80% to the Locked Reserve's fee contract${fl.full ? " (nine tenths locked as staked HYPE, one tenth for the drop)" : ""}, 20% to the creator's wallet (10% of the whole allocation)`]])}
      <div class="callout"><p>Ascend holds most creator fees until the coin's moving-average market cap stays above <b>$40,000 for an hour within 14 days</b> of launch. If it never does, or the coin goes quiet, the held fees are forfeited to Ascend's own buybacks.</p></div>`,
  },
  {
    group: "How it works", slug: "reserve", title: "The Locked Reserve",
    html: (S, fl = flow(S)) => `<p class="lead">The reserve is two copies of one small contract. Each holds assets, tracks how much was deposited, and can release only what it holds above that amount.</p>
      ${t(["Share of each fee that arrives", "Becomes", "Where it ends"], fl.split.map((q) => [share(q.share), ...({
        khype: ["kHYPE (Kinetiq staked HYPE)", "Locked in the reserve on Elysium"],
        kntq: ["sKNTQ (Kinetiq staked KNTQ)", "Locked in the reserve on HyperEVM"],
        drop: ["$liquid", "The drop: a wallet run by the protocol's bot, not locked. Burned instead once the drop is full"],
        aside: ["USDC", "Set aside, waiting"],
      })[q.key]]))}
      ${fl.full ? `<h2>How the split is set</h2>
      <p>The reserve's allocator was built to divide every fee 40 / 40 / 20 between kHYPE, staked KNTQ and $liquid, and that contract cannot be changed. What can be changed, through the 48-hour timelock, is what it is connected to. Since ${esc(fl.since)}:</p>
      <ul>
        <li><b>A router</b> turns the part meant for KNTQ into kHYPE and locks it in the reserve.</li>
        <li><b>A feeder</b> takes the 20% the allocator sets aside as USDC. Half buys kHYPE and locks it. Half buys $liquid for the drop.</li>
      </ul>
      <p>The owner can change this again the same way: in public, 48 hours ahead. Nothing already locked can be taken out by anyone.</p>
      <p>Two things remain from before. The staked KNTQ locked until then stays locked in the second reserve on HyperEVM. And a fee that is itself paid in KNTQ still sends 40% of itself there, because the allocator passes on a token it already holds without asking the router.</p>
      <h2>The drop</h2>
      <p>The drop is the vessel on the home page: a wallet run by the protocol's bot that collects $liquid. It is <b>not locked</b>. It is an ordinary wallet, because Ascend pays holder rewards to wallets only, so whoever controls the bot's key controls that $liquid.</p>
      <ul>
        <li>It is full when it holds <b>${share(fl.capShare)}</b> of the $liquid that has not been burned${fl.cap ? ` (${amount(fl.cap)} today)` : ""}.</li>
        <li>Once it is full, every further purchase goes to Ascend's BurnSink for good.</li>
        <li>The feeder counts what it has sent. A drop that was emptied is not filled a second time.</li>
      </ul>` : ""}
      <h2>Why "locked forever" is true</h2>
      <ul>
        <li><b>No owner, no admin.</b> There's no privileged address at all.</li>
        <li><b>No withdraw function.</b> The only function that sends assets out is <code>harvest</code>, and it can send only yield.</li>
        <li><b>Not upgradeable.</b> The code can't be swapped.</li>
        <li><b>One fixed destination.</b> Yield can go only to the yield contract set at deployment.</li>
      </ul>
      <p>Both reserve contracts are on the <a href="#/docs/contracts">Contracts page</a>, and their source is published on Sourcify as an exact match. They are unaudited.</p>
      <h2>What counts as yield</h2>
      <p>Principal is recorded in underlying units: HYPE for kHYPE, KNTQ for sKNTQ. As staking rewards raise each token's exchange rate, the reserve's holdings become worth more than principal. That surplus is yield.</p>
      <p>The reserve also limits how fast it will believe a rate has grown: at most <b>25% a year</b>. If a price source ever broke, it couldn't make principal look like yield.</p>
      <h2>Why staked KNTQ lives on HyperEVM</h2>
      <p>Kinetiq's staking vault is on HyperEVM, and only HyperEVM can unstake. So KNTQ meant for the reserve is bridged there, staked and locked in a second reserve. Any yield it earns is unstaked (7 days) and bridged back to Elysium. Kinetiq ended staker rewards in September 2026, so staked KNTQ earns nothing at present.</p>`,
  },
  {
    group: "How it works", slug: "yield", title: "Where the yield goes",
    html: (S, fl = flow(S)) => `<p class="lead">Yield is the only thing that leaves the reserve. A fifth of it goes to the creator. ${fl.yieldOn ? "The rest is divided by the yield director, a contract whose shares the owner sets and can change." : "The rest is held until the contract that divides it is in force."}</p>
      ${t(["Share of all yield", "Goes to", "What happens"], fl.yieldParts.map((q) => [share(q.share), esc(q.name), esc(up(q.does))]))}
      ${fl.yieldOn ? `<p>${fl.sharesText ? `These are today's shares, read from the chain when this page loaded. Of the director's part: ${esc(fl.sharesText)}.` : "The director's shares are read from the chain when this page loads."}</p>
      <h2>Who can change it</h2>
      <ul>
        <li><b>The creator's fifth</b> cannot be changed by anyone.</li>
        <li><b>The shares</b> can be changed by the owner's wallet at once, at any time, including to zero.</li>
        <li><b>A new destination</b> can only be added through the 48-hour timelock, in public. The timelock can also name a new manager for the shares, or a successor contract that takes the yield instead.</li>
      </ul>
      <h2>Small amounts wait</h2>
      <p>The bot passes yield on once it is worth at least $0.50 and ten times the network fee. While the reserve is small its yield is small too, so this can take a long time.</p>` : ""}
      <h2>Swap protection</h2>
      <p>Every swap is checked against a 30-minute average price and reverts if it would lose more than the slippage limit (1% at launch, 3% at most). Large amounts are processed in pieces, so buying is steady instead of all at once.</p>
      <h2>Where burned tokens go</h2>
      <p>Ascend tokens reject the usual burn address, so $liquid is burned into Ascend's <b>BurnSink</b>, a contract that reverts on every call and can never move tokens.</p>`,
  },
  {
    group: "How it works", slug: "staking", title: "Staking rewards",
    html: (S) => {
      const waits = Object.entries(S.pools ?? {}).filter(([, x]) => x?.exists && !x.tokenExists).map(([k]) => S.cfg?.elysium?.rewardPools?.[k]?.symbol).filter(Boolean);
      return `<p class="lead">Deposit liquidHYPE or liquidKNTQ in its reward pool and it earns $liquid as well, bought with a share of the reserve's yield.</p>
      <ul>
        <li><b>How to get there.</b> Stake HYPE or KNTQ on the <a href="#/stake">Staking page</a> and you receive liquidHYPE or liquidKNTQ. The Boost card on the same page deposits it in its reward pool.</li>
        <li><b>Pro-rata.</b> Rewards are shared by amount deposited, not per wallet, so splitting into many wallets earns nothing extra.</li>
        <li><b>Streamed over 7 days.</b> Depositing just before a payout and leaving right after earns almost nothing.</li>
        <li><b>No lock-up.</b> Take out or claim any time.</li>
        <li><b>No owner.</b> The pool contracts have no admin.</li>
        <li><b>The share can be zero.</b> The owner sets how much of the yield each pool gets and can change it at any time. The Boost card states what a pool pays per day right now. It never states a yearly rate.</li>
      </ul>
      ${waits.length ? `<p>${esc(waits.join(" and "))} does not exist on Elysium until the first KNTQ staking batch has crossed the bridge. Until then nobody can deposit in its pool, and its share waits there.</p>` : ""}
      <p>There is no pool for staking $liquid itself. All of this is separate from Ascend's holder rewards (25% of $liquid's share of the fee), which Ascend pays to eligible holders directly.</p>
      <div class="callout warn"><p>The reward pools have not been audited. Only deposit what you could afford to lose.</p></div>`;
    },
  },
  {
    group: "How it works", slug: "vaults", title: "Vaults",
    html: (S) => `<p class="lead">Vaults hold concentrated Uniswap v4 liquidity on Elysium for you and put the trading fees they earn back to work. They need no bot and no price feed to keep running.</p>
      <h2>How a vault works</h2>
      <ul>
        <li><b>Deposit with one token or both.</b> With one token, a helper contract (the zap) swaps the right share of it for the other token in the vault's own pool and deposits both. With both, they go in at the vault's current mix. Either way, whatever isn't needed comes back in the same transaction. HYPE goes in as native HYPE.</li>
        <li>The vault keeps a <b>main range</b> around the price and a side range for whichever token is left over.</li>
        <li><b>Fees compound.</b> Every deposit, and anyone pressing "Compound fees now", collects the trading fees and adds them to the ranges. The keeper bot also does it by itself whenever the fees waiting are worth at least 10 times the network fee of collecting them.</li>
        <li><b>Withdraw any time.</b> Withdrawals can't be paused. You receive your share of both tokens.</li>
        <li><b>A vault that is alone in its pool.</b> The ANTx-USDC vault holds USDC and wANTx (the wrapped Anthropic xStock, bridged from HyperEVM) in a pool where it is the only liquidity. Its pool's price follows the market only when someone trades against the vault, and it cannot swap its own surplus there, so after a large move it holds one token until trades come back. A first deposit into it while it is empty is made at the price of Hyperliquid's ANTX/USDC market: the site lines the empty pool up with that price first. That first deposit can be one token alone: it goes in as it is, with no swap, and waits beside the price (USDC as buy orders below it, wANTx as sell orders above it) until someone trades against it. After that, a one-token deposit swaps against the vault itself, so the site limits its size, sends part back as change in the other token, and cannot take the token the vault does not hold at the time. Its fee paid in wANTx is swapped like every other fee.${(S.cfg?.vaults ?? []).some((v) => v.id === "nvda-usdc") ? ` The NVDAx-USDC vault works the same way with wNVDAx (the wrapped NVIDIA xStock, also bridged from HyperEVM) and Hyperliquid's NVDAX/USDC market, and its fee paid in wNVDAx waits in the fee holding contract until the reserve has a route for it. wNVDAx also trades in other pools on Elysium, but the one against USDC runs through an add-on (a hook) that its owner can change, which the vault contract does not accept, so this vault has a new pool of its own as well. Both tokens are tokenised stocks: their issuer says xStocks are not available in the United States or to U.S. persons, are not currently available in the United Kingdom, and that other country limits apply. Liquid Reserve has no tie to the issuer, to NVIDIA or to Anthropic.` : ""}</li>
      </ul>
      <h2>Why the mix is fixed</h2>
      <p>A deposit only ever adds liquidity in proportion to what the vault already holds. That makes the pool price at that moment irrelevant: pushing the price around before depositing buys no extra shares. It's what lets the vault work without a price oracle.</p>
      <h2>Moving the range</h2>
      <p>When the price leaves the main range the vault stops earning until the range is moved. That's the one action where the pool price matters, so it's restricted:</p>
      <ul>
        <li>Only the vault's <b>keeper</b> address can do it.</li>
        <li>The keeper states the price it expects and how far the pool may be from it: 0.2% from this site and the keeper bot, never more than 2%. If the pool has moved further when the transaction lands, nothing happens.</li>
        <li>At most once every 15 minutes.</li>
      </ul>
      <p>The keeper can't take funds. The worst a dishonest keeper could do is move the range at a bad moment and cost depositors part of a price swing, which is why the keeper is disclosed and the owner can replace it.</p>
      <h2>Fees</h2>
      <p><b>20% of trading fees earned</b> goes to the protocol. ${creatorShare(S).vaultFees ? "For vaults opened before 17 November 2026, all of it goes to the Locked Reserve's fee contract. For vaults opened since, 80% goes there and 20% to the creator, through a splitter that cannot be changed." : "All of it goes to the Locked Reserve's fee contract. None of it goes to the creator. The fee is collected by a holding contract that is permanently pointed at the reserve."}${flow(S).full ? " What arrives there is divided like every other fee: nine tenths locked as staked HYPE, one tenth for the drop." : ""} There's no deposit or withdrawal fee.</p>
      <h2>Limits</h2>
      <ul>
        <li><b>Deposit caps</b> while the contracts are unaudited.</li>
        <li>The owner can change range widths, the keeper, the cap, and pause new deposits. Nothing else.</li>
      </ul>
      <div class="callout warn"><p>Providing liquidity carries impermanent loss: if the two tokens' prices diverge, a position can be worth less than simply holding them. A share's value moves with the token prices as well as with fees.</p></div>`,
  },
  {
    group: "How it works", slug: "hype-staking", title: "HYPE staking (liquidHYPE)",
    html: (S) => `<p class="lead">Stake HYPE on Elysium and receive liquidHYPE, a token you can hold, move or use elsewhere while your HYPE keeps earning staking rewards.</p>
      <h2>How it works</h2>
      <ul>
        <li><b>You stake HYPE.</b> The vault swaps it for kHYPE, Kinetiq's staked HYPE, in Uniswap's kHYPE pool on Elysium and holds the kHYPE for you.</li>
        <li><b>You receive liquidHYPE</b>, your share of the vault's kHYPE. It follows the standard vault interface (ERC-4626), so other apps on Elysium can build on it.</li>
        <li><b>kHYPE gains value against HYPE</b> as staking rewards come in, about 2% a year so far. That shows as 1 liquidHYPE being worth more HYPE over time. Nothing is minted to pay it.</li>
        <li><b>Unstake any time.</b> Back to HYPE through the same pool, or to the kHYPE itself. The kHYPE way out needs no pool and no price, and cannot be paused.</li>
      </ul>
      <h2>Fee</h2>
      <p><b>20% of the yield</b>, never of what you deposit. It is fixed in the contract, as is where it goes: 80% to the Locked Reserve's fee contract and 20% to the creator. There is no deposit fee and no withdrawal fee. Swapping HYPE for kHYPE and back pays the pool's own trading fee, like any swap.</p>
      <h2>Extra rewards</h2>
      <p>liquidHYPE can be deposited in its reward pool, the Boost card on the Stake page, to earn $liquid as well. The owner sets that pool's share of the reserve's yield and can change it at any time, including to zero. See <a href="#/docs/staking">Staking rewards</a>.</p>
      <h2>How yield is measured</h2>
      <p>Bridged kHYPE has no official exchange rate on Elysium, so the vault reads kHYPE's 30-minute average price in its pool, the same feed the Locked Reserve uses. Two rules keep that honest:</p>
      <ul>
        <li><b>High-water mark.</b> The fee is only taken on a rise above the highest level reached before. A dip and recovery is never charged twice.</li>
        <li><b>A ceiling of 5% a year</b> on the rise the vault will count. A wrong or pushed price therefore cannot cost stakers more than 1% of their stake a year in fees, and a fee taken early is not taken again when the real rate catches up.</li>
      </ul>
      <p>liquidHYPE itself is priced in kHYPE, not by that feed: what you can withdraw is your share of the kHYPE the vault holds.</p>
      <h2>The APY on the Stake page</h2>
      <p>It is worked out from Kinetiq's own rate for kHYPE on HyperEVM, the HYPE that one kHYPE redeems for: how much that rate rose over the last 7 days, turned into a yearly rate, with the vault's 20% fee taken off. The chart on the Stake page is the same rate since kHYPE began. It says what the last week earned. It is not a promise about the next one.</p>
      <h2>Limits</h2>
      <ul>
        <li><b>A deposit cap</b> while the contract is unaudited.</li>
        <li>The owner can pause new deposits and change the cap. Nothing else: not the fee, not where it goes, not the pool, and never withdrawals. The contract cannot be upgraded.</li>
      </ul>
      ${S.cfg?.elysium?.staking?.vault ? `<p>Contract: ${explorer(S.cfg, "elysium", "address", S.cfg.elysium.staking.vault)}</p>` : ""}
      <div class="callout warn"><p>This contract has not been audited. The price of kHYPE against HYPE is set by the market and can dip, and a large unstake to HYPE gets a worse price than a small one. Bridged kHYPE also depends on Kinetiq and on Elysium's bridge. Only stake what you could afford to lose.</p></div>`,
  },
  {
    group: "How it works", slug: "bridge", title: "Two chains and the bridge",
    html: () => `<p class="lead">Liquid Reserve runs on Elysium and HyperEVM, connected by Elysium's canonical bridge.</p>
      ${t(["Direction", "What moves", "How long"], [["Elysium → HyperEVM", "KNTQ to be staked: KNTQ staking batches, and 40% of any fee paid in KNTQ", "A day or more (it was about 6 days until mid-November 2026)"], ["HyperEVM → Elysium", "Unstaked sKNTQ yield (after a 7-day unstake)", "Minutes"]])}
      <p>Only KNTQ to be staked and its yield ever cross. Locked principal never crosses back.</p>
      <p>A transfer to Elysium that fails to execute automatically must be completed within 7 days. The keeper watches for this and completes it; anyone else can too.</p>`,
  },
  {
    group: "How it works", slug: "keeper", title: "Keeper and oracle",
    html: () => `<p class="lead">A keeper bot turns the flywheel. It has no power over funds: every function it calls is public, so anyone can run the same steps.</p>
      <h2>What the keeper does</h2>
      <ul>
        <li>Records pool prices each minute for the price oracle.</li>
        <li>Collects fees from Ascend and the vaults and moves them on: into the reserve and, for a tenth, the drop.</li>
        <li>Claims bridged KNTQ on HyperEVM, stakes and locks it.</li>
        <li>Harvests yield on both chains and passes it to the creator's splitter and the yield director.</li>
        <li>Compounds vault fees, and re-centres a vault's ranges when the price leaves them or the main range has emptied (only if it is that vault's keeper). Before moving a range it requires the price to have been steady for 10 minutes and to agree with Hyperliquid's own market.</li>
      </ul>
      <p>If the keeper stops, nothing is lost. Funds wait until it, or anyone, runs again. Vaults keep working without it: deposits, withdrawals and compounding need no bot.</p>
      <h2>The price oracle</h2>
      <p>The flywheel contracts (not the vaults) need prices to cap slippage. Uniswap v4 pools keep no price history, so the oracle builds a 30-minute average from recorded prices. A price recorded inside an attacker's own transaction carries no weight in that transaction, and the recorded price can move only about 0.1% per second.</p>`,
  },
  {
    group: "Reference", slug: "contracts", title: "Contracts",
    html: (S) => {
      const c = S.cfg, el = c.elysium, E = el.contracts, H = c.hyperevm.contracts, live = isLaunched(c);
      // The reserve that is live now (deployment.json -> prelaunch), with the flywheel contracts set since.
      const P = !live ? el.prelaunch : null, HP = !live ? c.hyperevm.prelaunch : null;
      const fw = el.flywheel ?? {}, drop = el.drop ?? {}, cs = el.creatorShare, fl = flow(S);
      const row = (chain, name, a, what) => [name, a ? explorer(c, chain, "address", a, short(a)) : `<span class="dim">Not deployed yet</span>`, what];
      const some = (rows) => rows.filter(Boolean);
      const elysium = P
        ? some([
            row("elysium", "LockedReserve", P.reserve, "Holds the locked kHYPE. No owner."),
            el.vaultFeeInbox && row("elysium", "Fee holding contract", el.vaultFeeInbox, "Where fees arrive. Pointed at the fee splitter for good."),
            row("elysium", "FeeSplitter", P.feeSplitter, "Passes fees on to the allocator. No owner."),
            row("elysium", "InflowAllocator", P.allocator, "Divides each fee 40 / 40 / 20. Cannot be changed; what it is connected to can."),
            fw.swapConfig && row("elysium", "SwapConfig", fw.swapConfig, "Names the swapper and price source the allocator uses. Owned by the timelock."),
            fw.hypeOnlyRouter && row("elysium", "HypeOnlyRouter", fw.hypeOnlyRouter, "Turns the allocator's KNTQ part into kHYPE and locks it. No owner."),
            row("elysium", "Set-aside contract", P.liquidWait, fl.drop ? "Holds the 20% set aside as USDC. Pointed at the drop feeder for good." : "Holds the 20% set aside as USDC."),
            drop.feeder && row("elysium", "DropFeeder", drop.feeder, "Half buys kHYPE for the reserve; half buys $liquid for the drop, or burns it once the drop is full. Owned by the timelock."),
            drop.wallet && row("elysium", "The drop", drop.wallet, "A wallet run by the protocol's bot. Not a contract, not locked."),
            row("elysium", "Yield contract", P.yieldWait, "Receives the reserve's yield. Pointed at the yield splitter for good."),
            cs && row("elysium", "YieldSplit", cs.yieldSplit, "20% of the yield to the creator's wallet, 80% on. No owner."),
            cs && row("elysium", "YieldRest", cs.yieldRest, fl.yieldOn ? "Holds that 80%. Pointed at the yield director for good." : "Holds that 80%."),
            fw.yieldDirector && row("elysium", "YieldDirector", fw.yieldDirector, "Divides it by shares the owner's wallet sets. A new destination takes the timelock."),
            ...Object.values(el.rewardPools ?? {}).map((x) => row("elysium", `${esc(x.symbol)} reward pool`, x.pool, `Deposit ${esc(x.symbol)}, earn $liquid. No owner.`)),
            cs && row("elysium", "VaultFeeSplit", cs.vaultFeeSplit, "For HYPE staking and vaults opened since 17 November 2026: 20% of the fee cut to the creator, 80% to the fee holding contract."),
            row("elysium", "BridgeOut", P.bridgeOut, "Sends KNTQ to HyperEVM."),
            row("elysium", "V4TwapOracle", P.oracle, "30-minute average prices."),
            row("elysium", "Timelock", P.timelock, "A 48-hour delay, in public, on every owner change to SwapConfig, the swapper, the price oracle, the drop feeder and the director's list of destinations."),
            el.staking?.vault && row("elysium", "HYPE staking vault", el.staking.vault, "liquidHYPE. Holds stakers' kHYPE."),
            el.kntqStaking?.queue && row("elysium", "KNTQ staking queue", el.kntqStaking.queue, "Collects KNTQ into batches for the bridge."),
          ])
        : [
            row("elysium", "LockedReserve", E.reserve, "Holds kHYPE and $liquid. No owner."),
            row("elysium", "FeeInbox", E.feeInbox, "Ascend's fee recipient; forwards to the fee router."),
            row("elysium", "FeeRouter", E.feeRouter, "Routes the protocol's fees into the reserve."),
            row("elysium", "InflowAllocator", E.allocator, "Splits inflows 40 / 40 / 20."),
            row("elysium", "YieldRouter", E.yieldRouter, "The six-way yield waterfall."),
            row("elysium", "CreatorPayout", E.creatorPayout, "Converts and pays the creator share."),
            row("elysium", "LiquidReserveStaking", E.staking, "Stake $liquid, earn $liquid."),
            row("elysium", "BridgeOut", E.bridgeOut, "Sends the KNTQ share to HyperEVM."),
            row("elysium", "V4TwapOracle", E.oracle, "30-minute average prices."),
          ];
      const hyperevm = HP
        ? some([
            row("hyperevm", "LockedReserve", HP.reserve, "Holds the locked sKNTQ. No owner."),
            row("hyperevm", "StakeAndLock", HP.stakeAndLock, "Stakes arriving KNTQ and locks it."),
            row("hyperevm", "YieldUnstakeBridge", HP.yieldBridge, "Unstakes yield and bridges it to Elysium."),
            el.kntqStaking?.hyperevm?.vault && row("hyperevm", "KNTQ staking vault", el.kntqStaking.hyperevm.vault, "liquidKNTQ. Holds stakers' sKNTQ."),
          ])
        : [
            row("hyperevm", "LockedReserve", H.reserve, "Holds sKNTQ. No owner."),
            row("hyperevm", "StakeAndLock", H.stakeAndLock, "Stakes arriving KNTQ and locks it."),
            row("hyperevm", "YieldUnstakeBridge", H.yieldUnstakeBridge, "Unstakes yield and bridges it to Elysium."),
          ];
      return `<p class="lead">${live || P ? "Deployed addresses. Each links to the block explorer. None of these contracts has been audited." : "The contracts aren't deployed yet. Addresses appear here at launch."}</p>
      <h2>Elysium</h2>
      ${t(["Contract", "Address", "Role"], elysium)}
      ${P && el.sourcify ? `<p>The source of the reserve contracts, the router, the drop feeder, the yield director and the reward pools is published on <a href="${esc(el.sourcify)}/${esc(P.reserve)}" target="_blank" rel="noopener">Sourcify</a> as an exact match to what is deployed. Published is not audited.</p>` : ""}
      <h2>Vaults (Elysium)</h2>
      ${t(["Vault", "Address", "Status"], (c.vaults ?? []).map((v) => [esc(v.name), v.address ? explorer(c, "elysium", "address", v.address, short(v.address)) : `<span class="dim">Created at token launch</span>`, (S.vaults ?? []).find((x) => x.id === v.id)?.live ? "Live" : v.address ? (S.vaults ? "Not deployed yet" : "…") : "—"]))}
      ${(c.vaults ?? []).some((v) => v.verified) ? `<p>The source code of both live vaults, the fee holding contract and the launcher is verified on the explorer${el.sourcify ? ` and on <a href="${esc(el.sourcify)}/${esc((c.vaults ?? []).find((v) => v.verified).address)}" target="_blank" rel="noopener">Sourcify</a>` : ""}: open an address above to read it.</p>` : ""}
      ${el.vaultFeeInbox ? `<p>Vault performance fees collect in ${explorer(c, "elysium", "address", el.vaultFeeInbox)}${P ? ", which is pointed for good at the reserve's fee splitter." : " until it is pointed, once, at the fee router."}</p>` : ""}
      <h2>HyperEVM</h2>
      ${t(["Contract", "Address", "Role"], hyperevm)}
      <h2>What is held</h2>
      ${t(["Asset", "Address", "Where"], [
        ["kHYPE", explorer(c, "elysium", "address", c.tokens.kHYPE.address), "Elysium · locked in the reserve"],
        ["sKNTQ", explorer(c, "hyperevm", "address", c.hyperevm.skntq), "HyperEVM · locked in the reserve"],
        ["KNTQ", explorer(c, "elysium", "address", c.tokens.KNTQ.address), "Elysium · on its way to HyperEVM"],
        ["$liquid", c.tokens["$liquid"].address ? explorer(c, "elysium", "address", c.tokens["$liquid"].address) : `<span class="dim">Created at launch on Ascend</span>`, fl.drop ? "Elysium · held by the drop, not locked" : "Elysium"],
      ])}
      <h2>The code</h2>
      <p>The contracts, their tests, the deployment records and the code of the bot and of this site are on <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>. A script there compares every source file Sourcify holds for every deployed address with the same file in the repository, byte for byte, and the README shows how to build the code and compare it with the chain yourself. Public is not audited.</p>
      <div class="callout warn"><p>Only trust addresses listed on <b>liquidreserve.xyz</b> or posted by <a href="${X_URL}" target="_blank" rel="noopener">@${X_HANDLE}</a>. Ascend's real app is linked from its docs; <b>ascend.now is not Ascend</b>.</p></div>`;
    },
  },
  {
    group: "Reference", slug: "security", title: "Security and status",
    html: (S, fl = flow(S)) => `<p class="lead">What's been done, and what hasn't.</p>
      <h2>Done</h2>
      <ul>
        <li><b>110 automated contract tests</b>, including fuzz tests and invariant tests on the reserve (principal changes only through deposits; holdings always cover principal; nothing leaves except yield).</li>
        <li><b>Vault tests</b> that fuzz deposits at any price and check they never dilute existing holders, and that pushing the price around a deposit loses money.</li>
        <li><b>Fork tests</b> against real Elysium and HyperEVM state: swaps through Ascend's pools, Kinetiq's sKNTQ vault, the bridge, and the vaults on the real HYPE-USDC and HYPE-KNTQ pools.</li>
        <li><b>End-to-end keeper run</b> on forks of both chains.</li>
        <li><b>Vault source code published and verified</b> on the Elysium explorer and on Sourcify, as an exact match to what is deployed. Anyone can read it and check it against the chain. Verified means the published code is the real code. It does not mean the code has been audited.</li>
        <li><b>Reserve and flywheel source published</b> on Sourcify as an exact match: the reserve contracts (live since 15 November 2026)${fl.full && fl.yieldOn ? `, and the HYPE-only router, the drop feeder, the yield director and the reward pools (in force since ${esc(fl.since)})` : ""}. They went live on mainnet without an audit.</li>
        <li><b>Code published on GitHub</b>: the contracts, their tests, the deployment records and the code of the bot and of this site, at <a href="${REPO_URL}" target="_blank" rel="noopener">github.com/packrvnner/liquid-reserve</a>. Anyone can build it and run the tests. Published is not audited.</li>
      </ul>
      <h2>Not done yet</h2>
      <ul>
        <li><b>Independent audit.</b> Not done. Everything on the <a href="#/docs/contracts">Contracts page</a> runs unaudited. The vaults and HYPE staking run with deposit caps until it is.</li>
      </ul>
      <h2>Who can change what</h2>
      ${t(["Contract", "Who controls it", "What they can do"], [
        ["Locked Reserve (both chains)", "No one", "Nothing. Immutable, no owner."],
        ["Fee splitter, allocator, yield splitter, HYPE-only router, reward pools", "No one", "Nothing. No owner."],
        ["Swap settings, swap adapter and price oracle", "48-hour timelock", "Set swap routes and price feeds, the slippage limit (3% at most), and which swapper and price source the allocator uses. That is how the reserve was made HYPE-only, and it can be changed back the same way. None of it touches what is already locked."],
        ["Drop feeder", "48-hour timelock", "Name a different drop wallet, or a successor contract that takes the set-aside USDC instead."],
        ["The drop", "The protocol's bot (an ordinary wallet)", "Holds the drop's $liquid. Not locked: the bot's key can move it."],
        ["Yield director", "The owner's wallet, and the 48-hour timelock", "Owner's wallet: change the shares between the listed destinations, at once. Timelock: add a destination, name a new manager, or name a successor contract that takes the yield instead. The creator's 20% is taken before the director and cannot be changed."],
        ["Vaults", "The owner wallet, and a keeper it picks", "Owner: range widths, keeper, deposit cap, deposit pause, within hard bounds. Keeper: move the range to the current price, rate-limited. Neither can take funds or stop withdrawals."],
      ])}`,
  },
  {
    group: "Reference", slug: "risks", title: "Risks and disclosures",
    html: (S) => `<p class="lead">Read this before you buy, stake or deposit anything.</p>
      <h2>Risks</h2>
      <ul>
        <li><b>Smart-contract risk.</b> The contracts are unaudited today. A bug in an immutable contract can't be fixed.</li>
        <li><b>The reserve is not a floor.</b> No one can redeem $liquid for a share of the reserve. The token's price can fall to any level.</li>
        <li><b>Kinetiq risk.</b> kHYPE and sKNTQ depend on Kinetiq. Locked assets can't exit if Kinetiq fails.</li>
        <li><b>Price risk.</b> The reserve is staked HYPE, plus the staked KNTQ locked before 25 November 2026. Its value in dollars moves with their prices.</li>
        <li><b>The drop is not locked.</b> It is a wallet run by the protocol's bot. If the bot's key were lost or stolen, the drop's $liquid could be moved. The reserve itself could not.</li>
        <li><b>The split can change.</b> The owner can change the yield shares at once, and the fee split through the 48-hour timelock. Reward pools can be set to pay nothing. What is already locked cannot be taken out.</li>
        <li><b>New contracts in the path of every fee.</b> A fault in the router, the drop feeder or the yield director could strand or lose fees and yield in transit. It could not release what is locked.</li>
        <li><b>Platform risk.</b> Elysium mainnet is new, and the token depends on Ascend's contracts and rules, including fee forfeiture if early thresholds aren't met.</li>
        <li><b>Bridge risk.</b> Assets in transit depend on Elysium's canonical bridge.</li>
        <li><b>Liquidity-provider risk.</b> Vault depositors face impermanent loss, and earn nothing while the price is outside the range.</li>
        <li><b>Keeper risk.</b> A vault's keeper chooses when to move its range. A dishonest or compromised keeper could do so at a bad price.</li>
        <li><b>Regulatory risk.</b> Rules for tokens that share revenue differ by country and may change.</li>
      </ul>
      <h2>Disclosures</h2>
      <ul>
        <li>The creator's wallet receives <b>10% of $liquid's share of the trading fee</b> (Ascend's "creator allocation"). ${yieldText(S)} ${vaultFeeText(S)}</li>
        <li>The team can never withdraw reserve principal.</li>
        <li>Price support comes only from the rule-based buybacks described in these docs. No one trades to move the price or create volume.</li>
      </ul>
      <div class="callout"><p>Nothing on this site is financial, legal or tax advice. Digital assets are volatile and you can lose everything you put in.</p></div>`,
  },
  {
    group: "Reference", slug: "faq", title: "FAQ",
    html: (S, fl = flow(S)) => `<h3>Can anyone ever withdraw the reserve?</h3><p>No. There's no function for it, no owner to add one, and the contract can't be upgraded.</p>
      <h3>Can I redeem $liquid for reserve assets?</h3><p>No. The reserve backs the flywheel, not a redemption price. Only its yield leaves: a fifth to the creator, the rest divided by shares the owner sets.</p>
      <h3>Where does the yield come from?</h3><p>Staking rewards on the reserve's kHYPE. The staked KNTQ still locked earns nothing at present. Nothing is minted to pay yield.</p>
      ${fl.drop ? `<h3>What is the drop?</h3><p>A wallet run by the protocol's bot that collects $liquid, shown as the vessel on the home page. ${share(fl.toDrop)} of every fee buys $liquid for it until it holds ${share(fl.capShare)} of the $liquid that has not been burned; after that, that part is burned instead. It is not locked. See <a href="#/docs/reserve">The Locked Reserve</a>.</p>` : ""}
      <h3>What is the point of a reserve nobody can touch?</h3><p>It never sells what is locked, and its yield keeps being paid out by the rules on the <a href="#/docs/yield">yield page</a> for as long as Kinetiq's staking runs.</p>
      <h3>What does the creator earn?</h3><p>10% of $liquid's share of the trading fee (what Ascend calls the creator allocation). ${yieldText(S)} ${vaultFeeText(S)} It's all on-chain and shown on the Reserve page.</p>
      <h3>What happens if the keeper goes offline?</h3><p>Funds wait. Every step is a public function, so anyone can call it.</p>
      <h3>Where do I follow updates?</h3><p>On X: <a href="${X_URL}" target="_blank" rel="noopener">@${X_HANDLE}</a>.</p>`,
  },
  {
    group: "Reference", slug: "brand", title: "Brand kit",
    html: () => `<p class="lead">The mark is a single droplet.</p>
      <h2>Logo</h2>
      <div class="assets">
        ${[["Mark", "brand/mark.png"], ["Logo on dark", "brand/logo-dark.png"], ["Logo on light", "brand/logo-light.png"], ["X profile picture", "brand/x-pfp.png"], ["X header", "brand/x-header.png"]]
          .map(([n, src]) => `<div class="asset"><div class="pic"${src.includes("light") ? ' style="background:#f2f3f3"' : ""}><img src="${src}" alt="${n}" loading="lazy" /></div><div class="meta"><span>${n}</span><a class="xl" href="${src}" target="_blank" rel="noopener">PNG ↗</a></div></div>`)
          .join("")}
      </div>
      <h2>Colour</h2>
      <div class="swatches">
        ${[["Jet", "#000000"], ["Panel", "#111112"], ["Chrome", "#F5F5F6"], ["Steel", "#A3ADB3"], ["HYPE mint", "#97FCE4"], ["Elysium sky", "#5EC4F2"]]
          .map(([n, h]) => `<div class="swatch"><i style="background:${h}"></i><div><b>${n}</b><span>${h}</span></div></div>`)
          .join("")}
      </div>
      <h2>Type</h2>
      <p><b>Geist</b> for everything, semibold and tightly tracked for headlines. <b>Geist Mono</b> for addresses. Both are open-source (SIL Open Font License).</p>
      <h2>Surface</h2>
      <p>Jet black, with liquid metal on the things you can press: a steel rim with mint and sky highlights that slides toward the pointer.</p>
      <h2>Name</h2>
      <p>Write <b>Liquid Reserve</b> for the project and <b>$liquid</b> for the token. Don't shorten the name to initials.</p>`,
  },
];

const find = (slug) => PAGES.find((p) => p.slug === slug) ?? PAGES[0];

export function view(S, slug) {
  const page = find(slug), i = PAGES.indexOf(page);
  const groups = [...new Set(PAGES.map((p) => p.group))];
  const nav = groups.map((g) => `<div class="grp">${g}</div>${PAGES.filter((p) => p.group === g).map((p) => `<a href="#/docs/${p.slug}" class="${p === page ? "active" : ""}">${p.title}</a>`).join("")}`).join("");
  const prev = PAGES[i - 1], next = PAGES[i + 1];
  return `<div class="page"><div class="docs">
    <nav class="docnav" aria-label="Docs">${nav}</nav>
    <article class="prose">
      <div class="docsel"><select id="docsel" aria-label="Docs page">${PAGES.map((p) => `<option value="${p.slug}"${p === page ? " selected" : ""}>${p.group} · ${p.title}</option>`).join("")}</select></div>
      ${eyebrow(`Docs · ${page.group}`)}<h1>${esc(page.title)}</h1>
      ${page.html(S)}
      <div class="docfoot">${prev ? `<a class="btn sm" href="#/docs/${prev.slug}">← ${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a class="btn sm chrome" href="#/docs/${next.slug}">${esc(next.title)} →</a>` : ""}</div>
    </article>
  </div></div>`;
}

export function mount() {
  document.getElementById("docsel")?.addEventListener("change", (e) => (location.hash = `#/docs/${e.target.value}`));
}
