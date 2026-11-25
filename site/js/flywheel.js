// The full flywheel: a six-station ring you can step through, then the exact
// path of the money for any trading volume.
import { usd, amount, pct } from "./format.js";
import { esc, eyebrow, segbar, icons, val, S as SER } from "./ui.js";
import { BANDS, flows, project, volOf } from "./analytics.js";
import { isLaunched } from "./data.js";
import { creatorShare, vaultFeeText, yieldText } from "./creator.js";
import { flow, share } from "./flow.js";

const fw = { station: 0, vol: 60, band: 2 };
const APR = 2.5; // illustrative kHYPE staking yield used for the yield row

const CAPS = ["Trade", "Split", "Lock", "Earn", "Distribute", "Tighten"];

/** The six steps, worded from what is in force on-chain right now (flow.js). */
function stations(S) {
  const fl = flow(S), toReserve = fl.drop ? "Reserve and the drop" : "Locked reserve";
  return [
  {
    cap: "Trade", big: "2%", small: "of every trade", title: "Every trade pays 2%",
    body: "$liquid trades against HYPE on Ascend with a 2% fee, on buys and sells. Ascend takes its cut from the first 1%. The rest is $liquid's share, which Ascend calls the creator allocation. It does not go to the creator: step 2 shows where it goes.",
    parts: (b) => [["$liquid's share (split in step 2)", 0.01 + b.creator], ["Ascend protocol", b.protocol], ["Ascend coin support (buys $liquid)", b.support]],
    bullets: ["The fee is paid in <b>HYPE</b>, the pair asset.", "Ascend's share shrinks as market cap grows, so $liquid's share rises from <b>1.35%</b> to <b>1.75%</b> of every trade.", "Launch liquidity is <b>locked</b> by Ascend."],
  },
  {
    cap: "Split", big: "25·25·50", small: "holders · burn · reserve", title: "The fee splits three ways",
    body: "Ascend splits $liquid's share by rules fixed at launch. A quarter pays holders, a quarter buys and burns $liquid, and half is paid out: 80% of that half to the reserve's fee contract and 20% to the creator.",
    parts: () => [["Holders", 25], ["Buy and burn $liquid", 25], [toReserve, 40], ["Creator's wallet", 10]],
    bullets: [`The creator's wallet gets <b>10%</b> of $liquid's share. The other <b>90%</b> goes to holders, burns${fl.drop ? ", the locked reserve and the drop" : " and the locked reserve"}.`, "These settings <b>can't be changed</b> after launch.", "Anyone can trigger each step; no one can redirect it."],
  },
  {
    cap: "Lock", big: fl.mix, small: fl.split.map((p) => p.tag).join(" · "), title: fl.full ? "Nine tenths are locked for good" : "The reserve locks it for good",
    body: `Of every fee that arrives, ${fl.splitText}. The reserve has no owner, no admin and no withdraw function, and it can't be upgraded.`,
    parts: () => fl.split.map((p) => [p.name, p.share * 100]),
    bullets: fl.drop
      ? [
          "<b>The drop</b> is a wallet run by the protocol's bot, shown as the vessel on the home page. It is <b>not locked</b>. It is a wallet because Ascend pays holder rewards to wallets only.",
          `The drop is full at <b>${share(fl.capShare)}</b> of the $liquid that has not been burned${fl.cap ? ` (${amount(fl.cap)} today)` : ""}. After that, the same tenth is <b>burned</b> instead.`,
          ...(fl.hypeOnly ? [`Until ${esc(fl.since)} the reserve also took in staked KNTQ. What was locked then <b>stays locked</b> on HyperEVM, and a fee paid in KNTQ still sends 40% of itself there.`] : []),
          "This split is set by contracts the <b>48-hour timelock</b> controls, so the owner can change it, in public and two days ahead. What is already locked can't be taken out.",
        ]
      : ["kHYPE is held on <b>Elysium</b>.", "KNTQ is bridged to <b>HyperEVM</b>, staked with Kinetiq and locked in a second, identical reserve.", "Principal only ever goes <b>up</b>."],
  },
  {
    cap: "Earn", big: "Yield", small: "the only outflow", title: "Only the yield can leave",
    body: "The reserve tracks principal for each asset. Anything it holds above principal is yield, and yield is the only thing the contract can send out, to one fixed address.",
    bullets: ["<b>kHYPE</b> grows in HYPE terms as staking rewards accrue.", fl.hypeOnly ? "The staked KNTQ still locked on HyperEVM <b>earns nothing at present</b>: Kinetiq ended staker rewards in September 2026." : "<b>sKNTQ</b> grows in KNTQ terms through Kinetiq's vault.", "A built-in cap (25% a year) stops a faulty price feed from releasing principal as yield."],
  },
  fl.yieldOn
    ? {
        cap: "Distribute", big: "20·80", small: "creator · yield director", title: "Yield is divided by shares",
        body: "A fifth of the yield goes to the creator's wallet, through a splitter that cannot be changed. The rest goes to the yield director, a contract that divides it by shares the owner sets. Nothing is paid by printing tokens.",
        parts: () => fl.yieldParts.map((p) => [p.name, p.share * 100]),
        bullets: [
          fl.sharesText ? `Of the director's part today: ${esc(fl.sharesText)}.` : "The director's shares are read from the chain when the page loads.",
          "The owner can <b>change the shares at any time</b>, including to zero. A new destination takes the <b>48-hour timelock</b>.",
          "Every share except compounding buys <b>$liquid</b>. A reward pool pays it out over <b>7 days</b> to people who deposited their staking token there.",
          "Every swap is checked against a <b>30-minute average price</b>.",
        ],
      }
    : {
        cap: "Distribute", big: "20·80", small: "creator · held", title: "Yield waits for its split",
        body: "A fifth of the yield goes to the creator's wallet, through a splitter that cannot be changed. The rest is held until the contract that divides it is in force. Nothing is paid by printing tokens.",
        parts: () => fl.yieldParts.map((p) => [p.name, p.share * 100]),
        bullets: ["Every swap is checked against a <b>30-minute average price</b>."],
      },
  {
    cap: "Tighten", big: "↻", small: "and around again", title: "Less supply, deeper liquidity",
    body: "Burns remove $liquid for good. The reserve never sells. Vaults deepen liquidity and send 20% of their fees to the reserve. More reasons to trade mean more fees into step one.",
    bullets: ["Burned tokens sit in Ascend's <b>BurnSink</b>, a contract that can't move them.", creatorShare(S).vaultFees ? "The vaults' 20% fee goes to the reserve, less a fifth of it from vaults opened since 17 November 2026, which goes <b>to the creator</b>." : "The vaults' 20% fee goes <b>entirely to the reserve</b>. None of it goes to the creator.", "Price support comes only from <b>disclosed, rule-based</b> buybacks funded by real revenue."],
  },
  ];
}

function ringSvg() {
  const C = 280, R = 180;
  const pos = (i, r = R) => { const a = ((-90 + i * 60) * Math.PI) / 180; return [C + r * Math.cos(a), C + r * Math.sin(a)]; };
  const stations = CAPS.map((cap, i) => {
    const [x, y] = pos(i), [lx, ly] = pos(i, R + 52);
    return `<g class="st${i === fw.station ? " on" : ""}" data-st="${i}" role="button" tabindex="0" aria-label="Step ${i + 1}: ${esc(cap)}">
      <circle cx="${x}" cy="${y}" r="30"/><text x="${x}" y="${y}">${i + 1}</text><text class="cap" x="${lx}" y="${ly}">${esc(cap)}</text></g>`;
  }).join("");
  const rings = [250, 215].map((r) => `<circle class="orbit" cx="${C}" cy="${C}" r="${r}" opacity="0.5"/>`).join("");
  return `<svg viewBox="0 0 560 560" role="group" aria-label="The Liquid Reserve flywheel, six steps">
    ${rings}<circle class="orbit" cx="${C}" cy="${C}" r="${R}"/><circle class="orbit dash" cx="${C}" cy="${C}" r="${R - 44}"/>
    <g class="runner"><circle cx="${C}" cy="${C - R}" r="4"/></g><g class="runner b"><circle cx="${C}" cy="${C - R}" r="3.2"/></g><g class="runner c"><circle cx="${C}" cy="${C - R}" r="3.2"/></g>
    ${stations}</svg>`;
}

function liveLine(S, i) {
  if (!isLaunched(S.cfg)) return "";
  const t = S.flywheel?.totals, r = S.reserves;
  const rows = [
    t && ["Fees collected to date", usd(t.feesUsd)],
    t && ["Sent to the reserve to date", usd(t.toReserveUsd)],
    r && ["Locked right now", usd(r.totalUsd)],
    r && ["Yield waiting to be harvested", usd(r.pendingUsd)],
    t && ["$liquid burned from yield", amount(t.burnedLr)],
    S.history && ["Supply burned, all sources", S.history.supply ? pct(S.history.burned / S.history.supply, 2) : "—"],
  ][i];
  return rows ? `<div class="kv" style="margin-top:16px"><span class="label">Live</span><span>${rows[0]}</span><b class="r">${rows[1]}</b></div>` : "";
}

function panelHtml(S, s) {
  const b = BANDS[fw.band];
  const parts = s.parts ? s.parts(b).map(([name, value], k) => ({ name, value, color: SER[k] })) : null;
  const total = parts?.reduce((a, p) => a + p.value, 0);
  return `${eyebrow(`Step ${fw.station + 1} of 6`)}<h3>${esc(s.title)}</h3><p class="muted" style="margin:0 0 16px">${s.body}</p>
    ${parts ? `${segbar(parts, { tall: true })}<div class="parts">${parts.map((p) => `<div><i style="background:${p.color}"></i><span>${esc(p.name)}</span><b>${pct(p.value / total, p.value / total < 0.1 ? 1 : 0)}</b></div>`).join("")}</div>` : ""}
    <ul>${s.bullets.map((x) => `<li><span>${x}</span></li>`).join("")}</ul>
    ${liveLine(S, fw.station)}
    <div class="nav"><button class="btn sm" type="button" data-step="-1">← Back</button><button class="btn sm chrome" type="button" data-step="1">${fw.station === 5 ? "Around again" : "Next step"} →</button></div>`;
}

function cascadeHtml(S) {
  const fl = flow(S), vol = volOf(fw.vol), f = flows(vol, fw.band, fl), p = project(vol, fw.band, APR, fl);
  const y = (p.m.kh[11] * APR) / 100; // a year of kHYPE yield on the kHYPE locked after 12 months
  const toReserve = fl.drop ? "Reserve and the drop" : "Locked reserve";
  const row = (title, sub, total, unit, parts) => {
    const ps = parts.map(([name, value], k) => ({ name, value, color: SER[k] }));
    return `<div class="cas"><div class="what"><b>${title}</b><span>${sub}</span><span class="amt">${usd(total)} <span class="dim" style="font-size:13px;font-weight:500">${unit}</span></span></div>
      <div>${segbar(ps, { tall: true })}<div class="parts">${ps.map((q) => `<div><i style="background:${q.color}"></i><span>${esc(q.name)}</span><b>${usd(q.value)}</b></div>`).join("")}</div></div></div>`;
  };
  return `<div class="tiles" style="margin-bottom:18px">
      <div class="card tile"><div class="k">Per $100 traded, locked forever</div><div class="v">${usd((f.locked / vol) * 100)}</div></div>
      <div class="card tile"><div class="k">Per $100 traded, buys $liquid</div><div class="v">${usd((f.bought / vol) * 100)}</div></div>
      <div class="card tile"><div class="k">Per $100 traded, paid to holders</div><div class="v">${usd((f.holders / vol) * 100)}</div></div>
      <div class="card tile"><div class="k">Per $100 traded, to the creator</div><div class="v">${usd((f.creator / vol) * 100)}</div></div>
    </div>
    <div class="card cascade">
      ${row("Trading fees", "2% of volume", f.fees, "a day", [["$liquid's share", f.alloc], ["Ascend protocol", f.ascend], ["Ascend coin support", f.support]])}
      ${row("$liquid's share", "Ascend's \"creator allocation\", split by settings fixed at launch", f.alloc, "a day", [["Holders", f.holders], ["Buy and burn $liquid", f.buyback], [toReserve, f.reserve], ["Creator's wallet", f.creator]])}
      ${row(toReserve, fl.full ? "nine tenths locked as staked HYPE, one tenth buys $liquid for the drop" : "converted and locked, never withdrawn", f.reserve, "a day", fl.split.map((q) => [q.short, q.share * f.reserve]))}
      ${row("Reserve yield", `a year of ${APR}% kHYPE yield on the reserve after 12 months`, y, "a year", fl.yieldParts.map((q) => [q.name, q.share * y]))}
    </div>`;
}

export function view(S) {
  const fl = flow(S);
  return `<div class="page">
    <section class="pagehead">${eyebrow("The flywheel")}<h1>Trade. Lock. <em>Earn. Burn.</em></h1>
      <p class="lede">${fl.full
        ? `Fees flow one way. Nine tenths become staked HYPE in a reserve no one can withdraw; one tenth buys $liquid for the drop. The reserve earns yield, and the yield is divided by shares the owner sets${fl.yieldUses ? `: today between ${esc(fl.yieldUses)}` : ""}.`
        : "Fees flow one way: into a reserve no one can withdraw. Only the reserve's yield ever leaves it."}</p></section>
    <section class="wheel">
      <div class="ring">${ringSvg()}<div class="core" id="core"></div></div>
      <div class="card chrome pad-lg panel" id="panel"></div>
    </section>
    <section>
      <div class="sec-head"><div>${eyebrow("Follow the money")}<h2>Where every dollar <em>goes.</em></h2></div></div>
      <div class="card" style="margin-bottom:18px"><div class="model" style="grid-template-columns:1.6fr 1fr">
        <div class="ctrl"><label for="f-vol"><span>Daily trading volume</span><b id="f-vol-v"></b></label><input id="f-vol" type="range" min="0" max="100" step="1" value="${fw.vol}" /></div>
        <div class="ctrl"><label for="f-band"><span>Market cap</span></label><select id="f-band">${BANDS.map((b, i) => `<option value="${i}"${i === fw.band ? " selected" : ""}>${b.name}</option>`).join("")}</select></div>
      </div></div>
      <div id="cascade"></div>
      <p class="note" style="margin-top:14px">Amounts are a model at constant volume and prices, not a forecast. The yield row counts kHYPE staking yield only, at an illustrative ${APR}%, divided by today's shares, which the owner can change.</p>
    </section>
    <section class="card pad-lg"><h3>Disclosures</h3>
      <p class="muted">The creator's wallet receives 10% of $liquid's share of the trading fee (Ascend's "creator allocation"). ${yieldText(S)} ${vaultFeeText(S)} Reserve principal can never be withdrawn, including by the team.${fl.drop ? " The drop's $liquid is held by a wallet the protocol's bot runs; it is not locked." : ""} KNTQ bridged to HyperEVM takes a day or more to arrive. The contracts have not been audited yet. Smart contracts can fail, and nothing here is financial advice. <a class="xl" href="#/docs/risks" style="font-size:13px">Read the risks ${"→"}</a></p></section>
  </div>`;
}

export function mount(S) {
  const root = document.getElementById("app");
  const paintStation = () => {
    const s = stations(S)[fw.station];
    root.querySelectorAll(".st").forEach((g) => g.classList.toggle("on", +g.dataset.st === fw.station));
    root.querySelector("#core").innerHTML = `<div class="big">${esc(s.big)}</div><div class="cap">${esc(s.small)}</div>`;
    const panel = root.querySelector("#panel");
    panel.innerHTML = panelHtml(S, s);
    panel.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => { fw.station = (fw.station + +b.dataset.step + 6) % 6; paintStation(); }));
  };
  root.querySelectorAll(".st").forEach((g) => {
    const go = () => { fw.station = +g.dataset.st; paintStation(); };
    g.addEventListener("click", go);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
  const paintCascade = () => {
    root.querySelector("#f-vol-v").textContent = usd(volOf(fw.vol));
    root.querySelector("#cascade").innerHTML = cascadeHtml(S);
  };
  root.querySelector("#f-vol").addEventListener("input", (e) => { fw.vol = +e.target.value; paintCascade(); });
  root.querySelector("#f-band").addEventListener("input", (e) => { fw.band = +e.target.value; paintCascade(); paintStation(); });
  paintStation();
  paintCascade();
}
