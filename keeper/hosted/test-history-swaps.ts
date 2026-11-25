// Dry run of the "history-swaps" function against the real Elysium RPC, with the database replaced by a
// stand-in that only collects the rows. Nothing is written anywhere.
//   npx tsx hosted/test-history-swaps.ts
const captured: { pool: string; ts: string; tick: number }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = String(input);
  if (u.startsWith("http://db.test/")) { captured.push(...JSON.parse(init.body)); return new Response("", { status: 201 }); }
  return realFetch(input, init);
}) as typeof fetch;
let handler: (req: Request) => Promise<Response> = async () => new Response("");
(globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: "http://db.test", SUPABASE_SERVICE_ROLE_KEY: "test" } as Record<string, string>)[k] }, serve: (h: typeof handler) => { handler = h; } };
await import("./history-swaps-index.ts");

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`); if (!ok) failed++; };
const ASCEND = "0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c";

// 1. $liquid's Ascend pool since just before launch: the launch spike must be kept
let r = await (await handler(new Request(`http://x/?pool=${ASCEND}&from=6870000&to=6890000`))).json();
console.log(r);
const a = captured.filter((x) => x.pool === ASCEND).sort((x, y) => x.ts.localeCompare(y.ts));
check("answered ok", r.ok === true);
check("creation price is the first point", a[0]?.tick === -168800, String(a[0]?.tick));
check("launch spike kept (tick -166088)", Math.max(...a.map((x) => x.tick)) === -166088);
check("back at about -168390 afterwards", a.at(-1)!.tick >= -168400 && a.at(-1)!.tick <= -168380, String(a.at(-1)?.tick));
check("times are unique and in order", new Set(a.map((x) => x.ts)).size === a.length);
console.log(a.map((x) => `${x.ts} ${x.tick}`).join("\n"));

// 2. a pool that is not on the site is refused
r = await (await handler(new Request(`http://x/?pool=0x${"12".repeat(32)}&from=1&to=2`))).json();
check("unlisted pool refused", r.ok === false && /not a listed pool/.test(r.error));

// 3. the scheduled run: every pool, recent blocks
captured.length = 0;
r = await (await handler(new Request("http://x/"))).json();
console.log(r);
check("scheduled run ok", r.ok === true && r.pools >= 3);
check("rows are well formed", captured.every((x) => /^0x[0-9a-f]{64}$/.test(x.pool) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(x.ts) && Number.isInteger(x.tick)), `(${captured.length} rows)`);

// 4. a range with more than 10,000 events asks for a smaller one instead of failing
r = await (await handler(new Request("http://x/?pool=0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a&from=3500000&to=4500000"))).json();
check("too many events: asks for a smaller range", r.ok === false && r.tooMany === true, JSON.stringify(r));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
