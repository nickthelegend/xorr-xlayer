# Test results — against `docs/TEST-PLAN.md`

Run 2026-09-19/20 (UTC) against the live deployments: web `xorr-xlayer.vercel.app`, fork executor `c29837a`, testnet
executor `c29837a`, hosted fork node, X Layer testnet, a local anvil fork of X Layer mainnet for J01–J03, and the iOS
simulator. Status is what was observed, never inferred.

## Summary

| Family | Total | PASS | FAIL | BLOCKED | Pending |
|---|---|---|---|---|---|
| G gates | 7 | 7 | 0 | 0 | 0 |
| C contract | 13 | 13 | 0 | 0 | 0 |
| J journeys | 13 | 11 | 0 | 0 | 2 (J08, J10 — at the UTC cap reset) |
| F fresh user + edges | 8 | 8 | 0 | 0 | 0 |
| E endpoints | 202 | 202 | 0 | 0 | 0 |
| S screens | 101 | — | — | — | sweep running |
| V self-verification | 3 | 3 | 0 | 0 | 0 |
| A agent | 5 | 4 | 0 | 1 | 0 |
| I infrastructure | 8 | 8 | 0 | 0 | 0 |
| H hackathon | 9 | 4 | 0 | 2 | 3 (owner actions) |

## G — Gates

| ID | Final | Evidence |
|---|---|---|
| G01 | PASS | `tsc` app: 0 errors |
| G02 | PASS | `tsc` executor: 0 errors |
| G03 | PASS | `npm run lint`: no output |
| G04 | PASS | 2,425 / 2,425 tests |
| G05 | PASS | forge unit 45/45; X Layer fork suite 6/6 |
| G06 | PASS | CI green on `7d23fd7`, `57c95ab`, `bbf45dc` (all three jobs); re-checked on each push |
| G07 | PASS | iOS bundle env: `EXPO_PUBLIC_API_URL` fork executor, `EXPO_PUBLIC_CHAIN_RPC` hosted fork, delegation `0xf50a…7819` |

## C — Contract

| ID | Final | Evidence |
|---|---|---|
| C01 | PASS | testnet grant read back exactly (J04); fork suite |
| C02 | PASS | fork suite `test_BuysAWrappedXStockDirectlyAgainstUsdc`; J01 "the delegation holds nothing" |
| C03 | PASS | fork suite `test_BuysThroughTheUsdgHop` |
| C04 | PASS | fork suite; J01 "the order is refused — daily_cap" |
| C05 | PASS | fork suite; J04 `VenueNotAllowed` on X Layer testnet |
| C06 | PASS | J04 `NotDelegate` on X Layer testnet |
| C07 | PASS | J01 close $49.95 back, "$50 left today" |
| C08 | PASS | J04 revoke tx + `PolicyRevoked`; J06 |
| C09 | PASS | `XorrDelegationVia.t.sol` 6/6 |
| C10 | PASS | unit suite (`OutputNotReceived`) |
| C11 | PASS | fork suite on X Layer state |
| C12 | PASS | unit suite; V01 `audit-anchor` held on chain |
| C13 | PASS | Sourcify: `0x156D…cA22` exact_match, `0x36d5…e196` exact_match |

## J — Journeys

| ID | Final | Evidence |
|---|---|---|
| J01 | PASS | `prove:fork` 21/21 incl. the agent sweep on the real schema; fill `0x019fb2…83fb`, close `0x11ba27…fe87`, revoke `0x34f764…1928` |
| J02 | PASS | `prove-yield` all checks: swap `0x9f16c4…5559`, owner holds 99.999999 aUSDT0, owner withdraw `0xff664a…c9520` |
| J03 | PASS | `prove-withdrawal` all checks: sold TSLAx, 300.04 USDT0 out of Aave, 699.95 USDC to "Cold storage" `0xa97b11…df36`; allowlist cooling-off refusals |
| J04 | PASS | `prove:testnet`: grant `0x173b1f…56ec`, `VenueNotAllowed`, `NotDelegate`, revoke `0x17cb79…8756`, `PolicyRevoked` |
| J05 | PASS | simulator: $100 × 7d signed in-app; `policyOf(0x95A0…)` = (`0xB3e9…EC21`, 100e6, 1790452762, false) |
| J06 | PASS | simulator: hold → "Trading stopped · confirmed on-chain"; tx `0x85c6cb…0579` status 1 **from the owner**; `revoked` true |
| J07 | PASS | simulator: Sell $20 → `closePosition` `0xafd0d5…3990` status 1; Activity "Sold 21% of TSLAx … $19.84"; 0.2649→0.2101 |
| J08 | PENDING | tapped buy waits for the UTC cap reset (the agent spent 96 of 100 on 2026-09-19); ticket refuses correctly meanwhile |
| J09 | PASS | hosted fork: Momentum Scout filled $24 TSLAx unprompted (`0x7deb69…a81e`) and kept to the cap; Activity names the agent |
| J10 | PENDING | D22 deployed in `c29837a`; the next reset-day sweep must show no second TSLAx entry for wallets holding TSLAx |
| J11 | PASS | simulator: "You have $0.00." / "Your permission allows $100.00 more today." / "You hold $96.66 of TSLAx." / "…" + disabled while re-quoting |
| J12 | PASS | `POST /orders` TSLAx $20 → `filled`, 0.0552 TSLAx at $362.49 |
| J13 | PASS | web `/deposit` renders address, balances, test-funds button; F03 faucet effect on chain |

## F — Fresh user and edges

| ID | Final | Evidence |
|---|---|---|
| F01 | PASS | `test-2454@privy.io`: `/wallet` null → `/wallet/create` row `cedbe7fc…` `0x6610…0dfF`, `cluster xlayer-fork`; second call same row |
| F02 | PASS | `/limits` `granted:false`, `/delegation` `null` |
| F03 | PASS | faucet sent 1,000 USDC (`0x7740de…a101`), chain `balanceOf` 1,000e6, OKB 0.05; repeat → `claimed_recently` with `nextAt` |
| F04 | PASS | qa-full: every wallet route 401 for no token and a forged token |
| F05 | PASS | qa-full: named 400/404 refusals, nothing written |
| F06 | PASS | qa-full: idempotency replays (alerts, orders) recorded once |
| F07 | PASS | qa-full E146 (OKX DEX "no" answer named), E074 `/history` inside its bound |
| F08 | PASS | simulator: app on `xlayer-fork` vs a `solana-fork` server → full-screen refusal, nothing signed |

## E — Endpoints

**202 / 202 PASS** on the hosted fork executor, 2026-09-19 20:2x UTC (`docs/qa/endpoints-xlayer.json`, each row carries
its `correct` contract and `observed` result).

## V — Self-verification

| ID | Final | Evidence |
|---|---|---|
| V01 | PASS | fork executor, owner `0x95A0…e615`: 20 pass, 0 fail, 0 skip |
| V02 | PASS | testnet executor: 12 pass, 0 fail, 8 skip (each names its reason) |
| V03 | PASS | web `/judge` renders the live checks |

## A — Agent

| ID | Final | Evidence |
|---|---|---|
| A01 | PASS | last TSLAx observation $365.306 = live X Layer mainnet quote $365.306 |
| A02 | PASS | runs $24, $18, $14, $10… = min(25, 25% of remaining) against the on-chain cap |
| A03 | PASS | unit suite: rules error, unreadable policy, unreadable holdings each refuse with nothing placed |
| A04 | PASS | `/activity/86/explain` → `explained`, Momentum Scout, "TSLAx is trading at the 100th percentile of the $362.49-$364.95 band…" |
| A05 | BLOCKED | no `OPENROUTER_API_KEY` anywhere (repo, `.env`, both Railway projects); the decision record is shown instead |

## I — Infrastructure

| ID | Final | Evidence |
|---|---|---|
| I01 | PASS | fork `/health` ok, `xlayer-fork`, `c29837a`, all dependencies up |
| I02 | PASS | testnet `/health` ok, `xlayer-testnet`, `c29837a`, delegation `0x156D…cA22` |
| I03 | PASS | fork node: `anvil/v1.7.1`, chain `0xc4` |
| I04 | PASS | `deploy:web` bundle check: fork executor + RPC, pinned `0xf50a…7819`, commit `b2251d5` |
| I05 | PASS | ACAO answers `https://xorr-xlayer.vercel.app` for both the app origin and a foreign one (browsers refuse the foreign) |
| I06 | PASS | `/verify idempotence` passes on both executors |
| I07 | PASS | none of the 4 real private keys in git history; no env/key file tracked |
| I08 | PASS | V01 `privy-policy` owned by key quorum, `privy-refusal` refused by policy |

## H — Hackathon

| ID | Final | Evidence / dependency |
|---|---|---|
| H01 | PASS | testnet contracts + fork of mainnet, OKB gas, OKLink links |
| H02 | PASS | J01, J07, J09, J12 |
| H03 | BLOCKED | OKX DEX live quote/fill needs `OKX_API_KEY`/`OKX_SECRET_KEY`/`OKX_PASSPHRASE`; code path proven (C09, `okxdex.test.ts`, settle tests) |
| H04 | BLOCKED | OKX Wallet connection needs the extension in a browser; web lists `okx_wallet` first (typechecked) |
| H05 | PASS | J04, J06, C08 |
| H06 | PASS | I01–I04 |
| H07 | OWNER | repo public at submission (history scan clean, I07) |
| H08 | OWNER | video |
| H09 | OWNER | Dev Day form |

## Browser audit, 2026-09-19/20 (Chrome + `tools/flows.mjs`)

Every flow below was driven in a real browser against `xorr-xlayer.vercel.app` and the hosted fork executor — clicked,
typed into, submitted twice, reloaded — with the console and the network watched throughout. Signing in through the
Privy form is done by `tools/flows.mjs` with Privy's own test credential; Claude in Chrome cannot type a one-time code.

| Flow | Result | Evidence |
|---|---|---|
| Sign-in form (email → code → wallet) | PASS | code field appears, wallet created, session held |
| Onboarding: welcome → goals → wallet | PASS | Continue disables at 0 goals selected and does nothing when clicked |
| Search by name, empty state, duplicates | FIXED → PASS | "tesla" answered TSLAx twice (catalogue + xStocks); now one row. "zzzz" → `Nothing matches "zzzz".` |
| Stock asset screen | FIXED → PASS | hero read the fork's frozen $220.17 against its own chart's $222.51; now both live, candles draw, 1D/1W/1M/1Y switch |
| Change label | FIXED → PASS | read "down 0.0%"; now "flat since Sep 19, 12:20 PM", and the chip is no longer red when flat |
| Order ticket (signed out) | PASS | "Sign in to trade", keypad, Max disabled, backspace to $0 |
| Order ticket (signed in, cap spent) | FIXED → PASS | floor 0.6877 sat ABOVE the 0.6844 estimate (two prices); now 0.6877 ≤ 0.6898 from one quote. Refusal in words + button not pressable |
| Swap (signed out) | FIXED → PASS | said "No quote" (a claim about the market) to a signed-out visitor; now "Sign in to see a quote" |
| Alerts: create, double-submit, reload, delete | PASS | two clicks → exactly one alert; listed after reload; deleted 200 |
| Alert form validation | PASS | empty price → "Enter a symbol and a price", button disabled |
| USDT0 → USDC conversion, signed in the app (B4) | FIXED → PASS | both signatures confirmed in Privy's dialog; "Converted 5.00 USDT0 to USDC."; 5.0016 → 0 on chain. The confirmation used to unmount with the balance |
| Rate screen | FIXED → PASS | said "USDC SUPPLY RATE" over a rate paid on USDT0; now names USDT0 and repeats the executor's sentence |
| Judge page (`/judge`) | PASS | 14/20 signed out with skips named; 20/20 with an owner address pasted |
| Executor unreachable, mid-session | PASS | last price kept, "Can't reach xorr… your funds and permission are on chain", retry works, "Back online" on recovery |
| Session cleared mid-session | PASS | falls back to a sign-in prompt, no placeholder values leak |
| 404 route | PASS | "There is nothing here", offers the wallet and the screen index |
| Mobile width (420px) | PASS | markets list, tab bar and honest "—" for unpriced commodities |
| Console / network | PASS | no app console errors on any screen tested; only third-party wallet-SDK logs (Coinbase chain support, injected providers) |

## Honest measurement, 2026-09-20 — every item run again

Counted only what was observed in this run. "Verified earlier" does not count.

| Item | Result | Evidence from this run |
|---|---|---|
| Contracts enforce cap, expiry, allowlist, floor, revoke | PASS | `forge test` 45/45 unit, 6/6 X Layer fork suite, locally |
| Contracts deployed and source-verified | PASS | Sourcify `exact_match` for both; 5,597 and 1,523 bytes of code on X Layer testnet |
| The permission on a public chain (README step 2) | PASS | `prove:testnet` ALL PASSED — grant, `VenueNotAllowed`, `NotDelegate`, revoke, `PolicyRevoked`, each an OKLink transaction |
| The whole loop on a fork (README step 3) | PASS | `prove:fork` ALL PASSED — $50 TSLAx into the owner's wallet, cap refusal, close outside the cap, revoke |
| Withdraw to an allowlisted address | PASS | `prove-withdrawal` all checks — 24h cooling-off refusals, TSLAx sold, 300.04 USDT0 out of Aave, 699.95 USDC to cold storage (`0x984a53…bba6`), reported twice and recorded once |
| Aave yield (USDC → USDT0 → supply → withdraw) | PASS | `prove-yield` ALL CHECKS PASSED |
| Real persisted database | PASS | a wallet row written at 20:40 UTC survived six executor redeploys; Postgres reports live in `/health` |
| 202 endpoint contracts | PASS | 202/202, 0 failed |
| `/verify` on the fork | PASS | 20/20 for a granted owner |
| `/verify` on the testnet | PASS | 13 pass, 0 fail, 7 skip — each skip names its reason |
| 101 screens | PASS | 101/101, no console errors |
| Sign-in → embedded wallet | PASS | real Privy form, test credential |
| Kill switch, held down, on the web | PASS | `revoked: true` on chain afterwards |
| The permission signed again in the app | PASS | 17 signatures — one per tradable token, then the grant — cap back to $100 |
| USDT0 → USDC converted in the app | PASS | both signatures confirmed; 5.0016 → 0 on chain; the card now says so |
| An agent nobody hired | FIXED | it traded for every granted wallet; now refused by name, proven by 54 unit tests and by `prove-yield` going green |
| OKX Wallet sign-in | PARTIAL | the live modal lists OKX Wallet first; connecting one needs the extension |
| OKX DEX routing | BLOCKED | no API credentials anywhere |
| LLM prose explanations | BLOCKED | no `OPENROUTER_API_KEY` anywhere |

## B — browser-driven items, final status (2026-09-20)

| ID | Status | Evidence |
|---|---|---|
| B01 | PASS | signed in through the real Privy form; the code field appears and the session holds |
| B02 | PASS | 0 goals selected → Continue disabled, clicking stays on `/goals` |
| B03 | PASS | "tesla" → exactly one TSLAx row (was two) |
| B04 | PASS | `Nothing matches "zzzz".` |
| B05 | PASS | TSLAx hero $365.38 = the chart's own marker; NVDAx $222.51 likewise (was $220.17 against $222.51) |
| B06 | PASS | "up 0.1% since Sep 19, 12:21 PM"; a rounded-to-zero change reads "flat" and is not drawn red |
| B07 | PASS | 1D/1W/1M/1Y redraw; the caption names the window the readings actually cover |
| B08 | PASS | "Sign in to trade", Max disabled, backspace to $0, no invented fee |
| B09 | PASS | 0.6877 ≤ 0.6898, both from one quote (the floor used to sit above the estimate) |
| B10 | PASS | "Your permission allows $4.00 more today." and the button cannot be pressed |
| B11 | PASS | "Bought 0.1380 TSLAx"; position 0.3201 → 0.4581 on chain; allowance $58 → $8; `0xc062c7…3bc` on Uniswap v3 |
| B12 | PASS | "Sign in to see a quote" (was "No quote") |
| B13 | PASS | two clicks → exactly one alert |
| B14 | PASS | "Enter a symbol and a price", button disabled |
| B15 | PASS | listed once after a reload |
| B16 | PASS | 25.0078 USDT0 shown, conversion offered |
| B17 | PASS | "Converted 5.00 USDT0 to USDC.", 5.0016 → 0 on chain |
| B18 | PASS | held down → `revoked: true` on chain, signed by the owner |
| B19 | PASS | 17 signatures, as the screen says; cap and expiry on chain afterwards |
| B20 | PASS | "USDT0 SUPPLY RATE 3.48%" with the executor's own sentence |
| B21 | PASS | 20/20 for a granted owner; 0 fail / 5 skip for an address that never granted |
| B22 | PASS | last price kept, "Can't reach xorr", retry restores, "Back online" |
| B23 | PASS | sign-in prompt, no placeholder value |
| B24 | PASS | "No price feed." / "No live NOPE price" / "Not tradable here" |
| B25 | PASS | "There is nothing here" |
| B26 | PASS | `/_dev/ui` and `/_dev/boom` both redirect to `/welcome` |
| B27 | PASS | 420px: no horizontal overflow, tab bar renders, "—" for unpriced |
| B28 | PASS | the new coin art (1086×1448), no video element, no other chain's mark |
| B29 | PASS | the wallet that hired nobody was never traded: its only fills say "Placed by you" |
| B30 | PASS | the wallet that hired Momentum Scout was traded unprompted — GOOGLx $24 at 00:01, AMZNx $18 at 00:11 — and skipped the TSLAx it already held (D22) |

Network and console on every item above: no app errors, no failed requests. Two third-party lines were removed at
source rather than excused — Coinbase Wallet's "chains are not supported" and its failed HEAD probe (the connector
cannot serve X Layer, so it is no longer offered), and the React Native shims' "Shims Injected" (web does not load
them). What remains on a page load is one Privy debug line: `Detected injected providers: Array(0)`.

## The fork was rebuilt, and everything re-verified on it (2026-09-20 00:22–01:00 UTC)

**What happened.** The hosted fork's clock only moved when something was sent, so at 00:00 UTC the day rolled over and
`remainingToday(owner)` still answered yesterday's spend — a judge opening the live link after midnight would have seen
a stale cap. Giving the node a block time (`--block-time 12`) fixed that at the root, and restarting it to apply the
change brought it up on an empty volume: anvil forked X Layer afresh, so the old chain, its contracts and every balance
on it were gone.

**How it was rebuilt** — in the project's own documented order, nothing improvised:

| Step | Result |
|---|---|
| `fork-bootstrap` | XorrDelegation `0xba23ece812dab11f66a39c9d273d40b716ecc93a`, XorrAuditAnchor `0x62d4ae85ad16df82b006173e1c4f158689d14140` |
| executor variables + redeploy | `/health` up, delegate funded, all dependencies green |
| `fork-grant` × 2 | both wallets granted $100/day to the hosted delegate `0xB3e9…EC21` |
| fork USDC | 1,000 USDC to each wallet, from the fork-only reserve |
| `reconcile:orphans --apply` | 21 runs the new chain never saw taken out of the book; `daily_spend` and every position corrected to match the chain |
| `deploy:web` | re-pinned to the new delegation, verified in the bundle |

**Re-verified on the rebuilt chain, from scratch:**

| Item | Result |
|---|---|
| `/verify` | 20 pass, 0 fail, 0 skip |
| Tapped buy | "Bought 0.1369 TSLAx", position 0 → 0.136859309 on chain, allowance $100 → $50, `0x5690205e…21cb` |
| Alerts: double submit, reload, delete | one alert created, listed, removed |
| USDT0 → USDC in the app | "Converted 8.00 USDT0 to USDC.", 8.0016 → 0 on chain |
| Kill switch, held | `revoked: true` on chain |
| Grant, 17 signatures | cap and expiry back on chain |
| Signed-out state | sign-in prompt, nothing leaked |
| Fork clock | 4 blocks in 45s, within 5 seconds of real time — the cap will roll over on its own from now on |

## Final pass on the rebuilt chain (2026-09-20 01:0x UTC)

Everything re-run after the rebuild and after the last fix, against `4e3fab0` / the web build pinned to
`0xba23ece8…cc93a`:

| Suite | Result |
|---|---|
| Screens | **101 / 101**, no console errors, no failed requests |
| Endpoint contracts | **202 / 202** |
| Signed-in journeys (`tools/flows.mjs`) | **ALL FLOWS PASSED** — including the refusal branch: "Your permission has nothing left to spend today." with the button disabled |
| `/verify`, fork | 20 pass, 0 fail, 0 skip (also 20/20 in the browser) |
| `/verify`, testnet | 13 pass, 0 fail, 7 named skips |
| Unit + integration | 2,455 passed |
| Typechecks, lint | clean |
| CI | green on the last five commits |
| Agent, hired wallet | GOOGLx $24, then AMZNx $18 — unprompted, inside the cap, never repeating a symbol it holds |
| Agent, unhired wallet | no trade at all; its only fills read "Placed by you" |
| Order beyond the wallet | "This wallet holds $908.00 of USDC, and the order needs $999999.00." — refused before signing |

## Judged-in-the-browser pass, 2026-09-20 01:00–03:00 UTC

Driven against the deployed build. Everything below was clicked, submitted, interrupted or backed out of — not read.

| Flow | Result | What it proves |
|---|---|---|
| First run on an account that had never signed in | PASS | sign-in → wallet created → Deposit's "Get 1,000 test USDC" → "Added 1,000.00 USDC." with balances and the next claim time |
| Backing out of a signature | FIXED → PASS | said "The user rejected the request" (viem's words); now "You cancelled the signature, so nothing changed." Nothing granted, modal closed, no console error |
| Reload mid-order, then ask again | FIXED → PASS | two fills and $20 for one intent; now one fill, allowance falls once — the held key outlives the page |
| An order bigger than the wallet | FIXED → PASS | reached the contract and came back as "ERC20: transfer amount exceeds balance"; now "This wallet holds $908.00 of USDC, and the order needs $999999.00." |
| "Sell everything" | FIXED → PASS | closed the position for $29.97 and printed the server's own `fork:0x64c4…` label as the receipt; now shows `0x67dd5048…`, one shared rendering with Activity and History |
| `/metrics` after a fork rebuild | FIXED → PASS | said "67.6% of attempts broke rather than filled" counting 21 fills a rebuilt chain no longer has; now filled 13, failed 2, "not on chain" 21, rate 13.3%, cause named `insufficient_funds` |
| Allowlist: invalid address, then a real one, then removal | PASS | "Not a valid address: it starts with 0x and has 42 characters", Add disabled; added → "Usable from Mon 7:24 AM, in 24 h · Pending"; Remove asks to confirm; executor agrees at every step |
| Recurring buy created from the composer | PASS | "NEXT THREE RUNS" dated, CTA "Buy $50 of XBTC, weekly", strategy live on the executor, paused afterwards |
| Notification toggles | PASS | switch flips the stored preference and back |
| Eighteen signed-in screens on a near-empty account | PASS | honest empty states ("Nothing has been sold yet, so nothing is realised.", "No addresses yet.", "Nothing running yet."), no undefined/NaN, no errors |
| Ticket on a wallet with no money | PASS | "You have $0.00." with the button disabled |
| Full plan re-run afterwards | PASS | 101/101 screens, 202/202 endpoints, all flows, 2,469 unit tests, typechecks, lint, CI |

## Full pass, 2026-09-22/23 — every item, fixes included

Run 2026-09-22 22:30 UTC → 2026-09-23 05:30 UTC against the live deployments, driven through Claude in Chrome for
everything reachable without a credential, `tools/flows.mjs` (Playwright, Privy test credential) for the signed-in
journeys, `tools/qa-full.mjs` for the endpoints, `tools/shoot.mjs` for the screens, and a local anvil fork of X Layer
mainnet for J01–J03. Final state: web `eb4a874`, both executors `94b9464` (server code identical to HEAD), fork node
with the clock-keeping entrypoint, CI green on `eb4a874`. Console and network were read on every browser item.

### Found and fixed in this pass

| # | Found (how) | Root cause | Fix | Re-verified |
|---|---|---|---|---|
| 1 | `/playbook/liq_squeeze_break_perp`: VERIFIED over "took no trades", 0 trades both halves (Chrome) | the book's export never loaded the instrument universe; every `_perp` strategy's listing check refused every symbol — 44 strategies replayed to 0 trades while the gauntlet traded them | export loads the universe (research repo `export_catalog.py`); book regenerated — 269 unchanged, the 44 now carry their trades; `catalog.test.ts` guards both ways (`a1a82b0`) | report shows +2.48% over 107 trades; header 10/65/238, "Showing 150 of 313" = catalog |
| 2 | METAx "+10% take profit" sold $10 for $9.99 (runs API) | exits compared a settling-chain entry with the market's mark; on a fork they differ by the market's move since the fork block | exits judged on what the sale would be paid on the settling chain; mainnet/testnet unchanged (`768b780`) | `exit-mark.test.ts` 5/5; all 5 fail on the old planner |
| 3 | `POST /orders` answered `price 379.22` for units that cost $365.41 (API + chain) | `run.ts` recorded the sizing mark as the fill price, and exits are armed from it — with fix 2 a new METAx buy would have sat past its own stop | a fill records USDC ÷ units read on chain; migration re-based the 3 live exits armed from a mark (METAx 745.63→673.02, MSTRx 163.89→158.51, COINx 199.24→194.79), 9 untouched (`94b9464`) | $10 buy: reported 365.4130 = chain 365.4130; exits read back |
| 4 | Fork 2h48m behind UTC; `/limits` chain $0 vs executor $10 (RPC) | forked anvil stamps interval blocks from the last block, so restarts lost their downtime | entrypoint aligns the clock at start and every minute, forwards SIGTERM so state is saved (`80d77a3`) | lag 10,122s → 13–23s; at 00:00:46 UTC the fork read 00:00:35 and chain = executor |
| 5 | "Back online" covered Buy; a tap on Buy did nothing; banner spanned the desktop window (Chrome) | the panel took touches; the banner rendered outside `PhoneFrame`; and inline `box-none` is silently dropped by react-native-web | banner inside the frame; panels compiled with `StyleSheet.create` `box-none`; candlestick hit layer too; audit forbids inline `box-none` (`92254fc`, `a841df5`) | `elementFromPoint` at Buy/Sell = the buttons under both banners; a real click on Buy opened `/order/TSLAx` |
| 6 | Live bundle named no commit | built from a dirty tree | redeployed from clean trees; bundle names `eb4a874` and matches the executor's server code | SHA in the served bundle |
| 7 | flows: NaN floor, `/alerts` 30s timeout, one silent sign-in failure | harness read at fixed moments and demanded a silent network from a polling app | waits for the floor, the prompt, and load + optional idle (`eb4a874`) | 3 consecutive runs 28/28 |
| 8 | `/playbook/b100_mtf_1` (never traded, even in the gauntlet): "Commission doubled +0.00%", "0.0000 R", "0/5", and a verdict built from those zeros (screen sweep `never +0.00%`) | the four tests' figures are the engine's starting zeros when nothing traded, and the report printed them as results | "What it was put through" says in one sentence that nothing traded, and prints none of them; `gauntletTraded` tested against the committed book (`0020eb0`) | Chrome: no `+0.00%`, no `0.0000 R`; a traded strategy still shows its four tests |

### Every item, final status

Legend: PASS = observed matching the plan's definition in this pass. UNTESTED = not exercised in this pass, with the reason;
the date of its last PASS is given where there is one. BLOCKED = needs a credential or device that does not exist here.

| Family | Result |
|---|---|
| G gates | G01 PASS (app `tsc` 0) · G02 PASS (executor `tsc` 0) · G03 PASS (lint clean) · G04 PASS (2,515 app + 1,212 executor tests) · G05 PASS (forge 51/51, incl. the X Layer fork suite) · G06 PASS (CI `checks`, `contracts`, `fork-e2e` green on `0020eb0`) · G07 UNTESTED — no iOS simulator session this pass (last PASS 2026-09-20) |
| C contract | C01–C12 PASS (forge 51/51; `prove:testnet` and `prove:fork` on chain) · C13 PASS (both testnet contracts Sourcify `exact_match`) |
| J journeys | J01 PASS (`prove:fork`, local fork, new code) · J02 PASS (`prove-yield`) · J03 PASS (`prove-withdrawal`, $699.95 to cold storage) · J04 PASS (`prove:testnet`, 6 OKLink txs) · J05 PASS on the web (grant signed in the app, 17 signatures, chain reads the cap) · J06 PASS on the web (held → `revoked: true`, owner-signed) · J07 PASS via `POST /positions/close` ($129.882038 = USDC that arrived; cap untouched) — the tapped *sell* on the native ticket UNTESTED (no simulator) · J08 PASS (tapped $50 buy in the web ticket, position grew on chain, cap −$50) · J09 PASS (Momentum Scout's 12 fills, attributed) · J10 PASS (METAx re-entry only after its exit sold the whole position) · J11 PARTIAL — the allowance guard PASS (B10); the "more than you have" and "more than you hold" sentences UNTESTED in the UI this pass (unit-tested in `src/markets/ticket.ts`; last observed 2026-09-20) · J12 PASS ($20 then $10 TSLAx via `/orders`, chain-checked) · J13 PASS for the address and balances (flows §3); the faucet send UNTESTED this pass (endpoint contract E069/E071 PASS) |
| F edges | F01–F03 UNTESTED — they need a Privy identity with no wallet on this deployment; creating one is an account creation this run does not do (last PASS 2026-09-20 on test-4668) · F04 PASS (every route 401 unsigned and forged, qa-full) · F05 PASS (named 400/404s, qa-full) · F06 PASS (idempotent replay, API + flows §1c) · F07 PASS (qa-full E146, E074) · F08 UNTESTED — native-only (last PASS 2026-09-20 on the simulator) |
| W money out | W1–W8 PASS (qa-full E188–E199; `prove-withdrawal` §4) |
| F2 fresh user | F2.2, F2.5, F2.6, F2.8, F2.9, F2.11 re-run PASS on test-8958 (not fresh) · F2.1, F2.3, F2.4 (on a fresh identity) UNTESTED this pass, as F01–F03 · F2.7, F2.10 PASS (trail 0 link breaks; agents listed) |
| E endpoints | **205 / 205 PASS** against `94b9464` (`docs/qa/endpoints-xlayer.json`) |
| S screens | **104 / 104 PASS** against `0020eb0`, console and network clean (`docs/screens/qa-report.json`) |
| V self-verification | V01 PASS (20/20 with the owner) · V02 PASS (testnet: 0 fail, every skip named) · V03 PASS (`/judge` 20/20 in Chrome) |
| A agent | A01 PASS (fork prices track live pools: TSLAx $379.03 hero = chart = latest reading) · A02 PASS ($24/$18/$14/$10 = min(25, 25% of remaining)) · A03 PASS (unit suite) · A04 PASS (`/activity/587/explain` → `explained`, decision record) · A05 BLOCKED (no `OPENROUTER_API_KEY`) |
| I infrastructure | I01–I06 PASS · I07 PASS (every commit of this pass scanned: no key material, no env/key files) · I08 PASS (policy owned by the quorum; Privy refuses out-of-policy) |
| H hackathon | H01, H02, H05, H06 PASS · H07 PASS (repo public, pushed) · H03 BLOCKED (no OKX DEX API key) · H04 BLOCKED (OKX Wallet extension) · H08 owner (video exists, 2:43, no iOS clip) · H09 owner (the form) |
| B browser | B01–B15 PASS · B16, B17 PASS (5.000986 USDT0 converted, two signatures, 0 left on chain) · B18, B19 PASS · B20–B30 PASS · B31 UNTESTED this pass — needs a granted wallet holding less USDC than its allowance (unit-tested, `4e3fab0`; last PASS 2026-09-20) · B32 PASS (00:00:46 UTC: fork 00:00:35, chain = executor) |
| P strategy book | P01–P06 PASS |
| R found this pass | R01–R07 PASS |

**No mocks, stubs or fallback data were added anywhere in the product.** Every fix changes what the product computes or
shows; the tests added are unit tests beside the code (mocks there are test doubles, as the suites already use) and
checks against the committed data. **Console and network:** zero errors on every item driven in Chrome, the 104
screens and every flow step — the only console line seen was Privy's own `DEBUG` "Detected injected providers".

## 2026-09-25 — keys, the Privy move, a fresh fork, and everything again

**Changed:** OKX DEX and OpenRouter keys live on the executors; Privy moved to the app with Google, X and GitHub on
(`cmqjx4iu…`, key quorum `nl4l7bet…`); the hosted fork re-taken at X Layer block 71,554,238 (XorrDelegation
`0x141e…5ef5`, anchor `0x4c4e…1594`); landing deployed at xorr-xlayer-landing.vercel.app; mainnet prepared and
rehearsed but not run (`docs/MAINNET.md`); the iOS simulator build is this repo's (`npm run ios:sim`).

**Found and fixed**

| # | Found | Fix | Verified |
|---|---|---|---|
| 1 | OKX quoted mainnet, the fork filled on stale pools: an OKX pick could revert where Uniswap would fill | `viaWouldFill` simulates the exact `spendVia` call first (`188f8d0`) | `prove:okx` ALL PASSED on a fresh fork; on the hosted fork a $50 USDT0 order and Momentum Scout's own $19 METAx buy settled through OKX DEX, allowance to OKX 0 after |
| 2 | Google / X / GitHub answered 403 `disallowed_login_method` (read from Privy's public app config) | moved to the owner's app with them on; GitHub button added (`b9db107`, `c0900a6`) | each hands off to accounts.google.com, x.com/i/oauth2, github.com/login/oauth; the wallet list opens with OKX Wallet first |
| 3 | The judge's proof wallet id belonged to the old Privy app | checked before use and re-minted when unknown (`c0900a6`) | `privy-refusal` passes on both executors |
| 4 | Test tokens failed on the new app: 403 "Must specify origin" | `e2e-token.ts` logs in naming the site (`9909beb`) | tokens verified by the live executor |
| 5 | A funded wallet with no permission saw "Buy" live | the ticket says there is no permission and disables the button (`9909beb`) | 3 unit tests |
| 6 | `/wallet/tokens` took 31.7s cold: prices awaited uncapped, then discarded | `heldUnits` — balances without prices (`9947f54`) | 3.3s cold, 0.4s warm; Holdings passes; Deposit shows the 50.0032 USDT0 |
| 7 | The simulator ran the Solana build (same bundle id); an unsigned rebuild had no keychain entitlement | this repo's build, ad-hoc signed (`7738d9f`) | welcome screen on the iPhone 17 Pro; no keychain errors since |
| 8 | Landing CTAs went to app.xorr.finance (the Base app) | point at the X Layer app (`3036f60`) | served page: "Built on X Layer", 6 links to xorr-xlayer.vercel.app, none to the Base app |

**Final measurement, against web and executors at `9947f54`:** app tests 2,520/2,520 · executor tests 1,214/1,214 ·
typechecks and lint clean · CI green (`checks`, `contracts`, `fork-e2e`) · endpoints 205/205 · screens 104/104
(`/disposals` failed once on a request Railway's edge dropped before it reached the executor — every logged
`/delegation` was 200 with the CORS header — and passed 3/3 re-taken alone) · signed-in flows 31/31 on the new
Privy app, and the 17-signature grant signed in the app · `/judge` 20/20 for the demo wallet · the mainnet code path
booted in mainnet mode against a fork of mainnet: 12 pass, 0 real failures (CoinGecko rate-limited that machine's IP).

**Not done:** the orphan reconcile on the old chain's fills (they belong to the previous Privy identities, which no
longer sign in; the audit trail is untouched); mainnet itself, which waits for funds and the owner's go-ahead.

## 2026-09-25 (afternoon) — each agent's own budget, OKX DEX first, and X Layer mainnet

**Changed:** `XorrDelegation` gained a budget per agent (`setAgentBudget`, `spendForAgent`, `closeForAgent`, filed under
`keccak256("xorr-agent:" + agent id)`); the executor settles every agent-attributed buy through it and reads the budget
before it signs; the app sets it from the agent's page with the owner's own signature. Routing is OKX DEX first, Uniswap
v3 only where OKX has no route, would not fill here, or delivers more than 0.5% less. Redeployed with the new contract:
hosted fork `0xAf70…7058`, testnet `0x0b83…E6B2` (Sourcify exact), and **X Layer mainnet — XorrDelegation
`0x156DCE9E9d523775AB51f882616A431EdBfBcA22`, XorrAuditAnchor `0x36d503D1893CAB30B5D68DC9A96e8B91bfcBe196`, both
Sourcify exact match**, with a mainnet executor (`executor-mainnet`) on its own database.

**Found and fixed (a read-only review by a second session, then fixed here)**

| # | Found | Fix | Verified |
|---|---|---|---|
| 1 | Firing an agent paused its exits too, now that exits carry the agent | `kind <> 'exit-rules'` on the fire (`2412174`) | `agent-budget.test.ts` |
| 2 | An unbudgeted agent ranking first blocked every budgeted agent, every tick | budgets read first; only funded agents take setups; none funded → nothing scanned (`2412174`) | `autonomous.test.ts` (3 new) |
| 3 | A sale could credit an agent for shares it never paid for | an agent's exit sells its own lot (`lotUnits`) and only that credits; every other sale is the owner's (`2412174`) | `planners.test.ts`, `agent-limits.test.ts` |
| 4 | An approved proposal from an agent's strategy was not charged to the agent | `placeOrder` gets the strategy's agent (`2412174`) | `extra.test.ts` (2 new) |
| 5 | Half a cent over the budget passed the pre-check and reverted | compared in raw units (`2412174`) | `agent-limits.test.ts` |
| 6 | A made agent's first run, before its budget, spent the week's period | no budget → wait without claiming; runs on the first tick after the owner signs (`073bc45`) | `agent-limits.test.ts`; observed |
| 7 | The mainnet service had no pre-deploy migration (created empty) | `npm run migrate` set as its pre-deploy command | `/verify` on mainnet: 13 pass, 0 fail |

**Measured**

- Gates: app 2,559/2,559 · executor 1,250/1,250 · both typechecks and lint clean · forge 70/70 (64 unit incl. 19 budget
  tests with a 256-run fuzz, plus the 6 X Layer mainnet-fork tests).
- Flows, signed, on the hosted fork with the new contract: ALL PASSED twice — stop all (revoke) held down, the
  17-signature grant ($1,000/day), and **one signature setting Momentum Scout's budget from its page** (the card reads
  the chain's figure; `GET /agents` reads the same; Activity has "Budget set" with the transaction).
- **An agent's own trades, charged on chain:** Momentum Scout's autonomous MSFTx buy `0x0434b037…c32ec` carries
  `AgentSpent(owner, key, $25, $25 left)`; its TSLAx strategy run `0x0f222b34…6f16b` settled through **OKX DEX** and
  carries `AgentSpent($10, $40 left)`; `GET /agents` then reads $40 (`tools/prove-agent-budget.mjs`).
- `/verify` for the demo wallet on the fork: 20/20. On mainnet with no wallet: 13 pass, 0 fail, 7 not applicable yet.
- Endpoints: 202/205 on the fork. The three: E073 was the harness given a short SHA (passes with the full one); E057
  and E077 expect `/limits` spent today to equal the chain's, and the executor's own tally is larger ($134 against the
  new contract's $35) because it also counts today's fills under the previous contract — the stricter figure binds by
  design, and the two agree again at 00:00 UTC.
- Screens: 105/105 signed in on the fork build (the new `98b-agent-budget` screen — a hired agent's page with its
  budget read from the contract — failed once only for having no expectation written yet, and passed with one).
- Mainnet: the executor boots with `ALLOW_MAINNET=yes`, migrations applied; its database was seeded with 55,730 X Layer
  pool readings for the 11 xStocks (since 2026-09-19), which the fork executor had recorded from the live mainnet pools
  — each row's `source` says so — so the agents' bands and the charts start from real history rather than from nothing.
