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
