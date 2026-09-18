# xorr test plan — every component and flow, with what correct means

Written 2026-09-14, before this run's testing, as the checklist everything is measured against. Each item has an id, the
surface that proves it, an exact definition of correct, and a status. A status is only ever one of:

- **PASS** — observed on the real product, matching the definition exactly, with no console error and no failed request
  (4xx/5xx other than the documented `503 warming` handshake) on that item.
- **FAIL** — observed, and something differed. The fix (commit) and the re-run are recorded against the item.
- **UNTESTED** — could not be exercised for a stated reason (a credential or device this run does not have, real money,
  or a step only the owner may take). Never used to hide a failure.
- **NOT BUILT** — the item describes something the product does not do yet (it is on docs/FEATURES.md).

What "real" means here: the hosted web app (https://app.xorr.finance, Vercel), the two hosted executors
(https://executor-fork-production.up.railway.app on the Base mainnet fork, https://api.xorr.finance on Base Sepolia),
their real databases, the deployed contracts, and the real third-party APIs with the credentials already configured.
Nothing is mocked. The test account is `test-8958@privy.io`, wallet `0x95A0b368588713011a15f4b1041423f31B08e615`.

## Surfaces and who can drive them

| Surface | How it is driven | Limits |
| --- | --- | --- |
| **Web, signed out** | Claude in Chrome on app.xorr.finance; console via the extension, network via `performance.getEntriesByType('resource')` (status per request) | none |
| **Web, signed in** | Claude in Chrome after the owner signs in in that browser | This run never types an email code or credential into a browser or UI. Until the owner signs in there, signed-in web items are proven on the next surface and marked `web: UNTESTED (owner sign-in)` |
| **Native, signed in** | The iOS Simulator (iPhone 17 Pro) running the Debug build against Metro, pointed at the fork executor, already signed in as the test account; deep links `xorr://<route>`, screenshots, Metro's device log | Face ID is not enrolled, so the biometric prompt is skipped by the app's own rule |
| **API** | `tools/qa-full.mjs` against each executor with a real Privy access token for the test account (`server/src/e2e-token.ts`) | Routes that trade, sign, push, call a paid model or need operator keys run through their refusals only (the script's `NOT_EXECUTED` list) |
| **Chain** | Reads from the fork RPC (https://base-fork-production.up.railway.app) and Base Sepolia; proofs on a local anvil forked from the hosted fork (`tools/prove-stop-without-server.ts`, `tools/prove-user-signing.ts`) | Mainnet is never written. Real money is never spent |

## Global rules — true of every item

- **G1 Signed out.** Every private route shows the one-line sign-in prompt (`Sign in to see this.` + `Sign in`, or the
  screen's own signed-out line) and requests no private endpoint: the network log has no `401`.
- **G2 A failed read is a failure.** An unreadable value renders as `—` or the error state with `Try again`; never `$0`,
  `None`, an empty list, `Not granted` or a fixture. Under a server fault or timeout the error shows `Ref xxxxxxxx`.
- **G3 Words.** No emoji, no `!`; at most one short line per section; no chain, venue or vendor name on a main screen (the
  network chip appears only where money moves: Deposit and Send); percentages of a whole are unsigned; green/red only for
  profit and loss.
- **G4 Console and network.** No console error on load or on any control; no 4xx/5xx except `503` with `Retry-After`.
- **G5 Web hosting.** Every route answers 200 from the SPA; `/` carries `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Strict-Transport-Security: max-age=31536000`, `Permissions-Policy: camera=(), geolocation=()`; the bundle names its
  commit and pins the executor's delegation contract; `manifest.webmanifest` and its icons are served as their types.

---

## A. Screens — 102 routes

Per-route definitions of correct (what is on screen when loaded; the loading, empty and error states; what must not
show; what every control does; how the route is reached) are the rows of [docs/qa/SCREENS.md](qa/SCREENS.md), ids
S001–S102. A route passes on a surface only when every clause of its row holds there and G1–G4 hold.

<!-- SCREENS:BEGIN -->
| Id | Route | Auth | Web, signed out | Native, signed in | Web, signed in |
| --- | --- | --- | --- | --- | --- |
| S001 | `/welcome` · `/welcome` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S002 | `/goals` · `/goals` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S003 | `/wallet` · `/wallet` | No (this is sign-in) | Not run | Not run | UNTESTED (owner sign-in) |
| S004 | `/fund` · `/fund` | No (address needs a session) | Loaded content and console PASS at web 2fa214a (Chrome, signed out): `3/3`, `Fund the wallet`, the chip `Base fork · Test`, `Send USDC to your address.`, `Sign in to see your address.` with `Sign in`, `Continue — set the limits`. Controls not yet driven: with the display locked, no click reached the chip (the page's own event log recorded none); the same chip opens Networks on Deposit and Send | Not run | UNTESTED (owner sign-in) |
| S005 | `/delegate` · `/delegate` | Yes (the user's Privy wallet signs) | Not run | Not run | UNTESTED (owner sign-in) |
| S006 | `/proposal` · `/proposal` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S007 | `/` · `/` (also `/?tab=futures`) | Yes (no wallet → redirect `/welcome`) | Not run | Not run | UNTESTED (owner sign-in) |
| S008 | `/markets` · `/markets` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S009 | `/holdings` · `/holdings` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S010 | `/more` · `/more` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S011 | `/bot` · `/bot` | No (drawer content needs a session) | Not run | Not run | UNTESTED (owner sign-in) |
| S012 | `/portfolio` · `/portfolio` | Yes (sheet) | Not run | Not run | UNTESTED (owner sign-in) |
| S013 | `/balance` · `/balance` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S014 | `/allocation` · `/allocation` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S015 | `/deposit` · `/deposit` | Yes | PASS at web 2fa214a (Chrome, signed out): `Deposit`, the chip `Base fork · Test`, `Sign in to see your address.` and `Sign in`; the chip opens `/networks`; no console message. `Sign in` not pressed: it asks for an email code | Loaded content and console PASS at 2fa214a (Metro, the fork executor), after `src/chain.ts` became records: the chip `Base fork · Test`, the full address, `Test network. Use test funds.`, USDC 25,517.19, ETH 9.9996, `Get 1,000 test USDC`; no Metro error. Controls not yet driven (screen locked) | UNTESTED (owner sign-in) |
| S016 | `/send` · `/send` | Yes | PASS at web 2fa214a (Chrome, signed out): `Send`, the chip `Base fork · Test`, `Sign in to send.` and `Sign in`; the chip opens `/networks` on a click the page recorded (pointerdown, mousedown, click at its centre); no console message. `Sign in` not pressed: it asks for an email code | Not run | UNTESTED (owner sign-in) |
| S017 | `/withdraw-everything` · `/withdraw-everything` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S018 | `/sell-everything` · `/sell-everything` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S019 | `/flatten` · `/flatten` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S020 | `/yield` · `/yield` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S021 | `/rates` · `/rates` | Partly (rate public; `YOURS` needs a session) | Not run | Not run | UNTESTED (owner sign-in) |
| S022 | `/limits` · `/limits` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S023 | `/spend` · `/spend` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S024 | `/history` · `/history` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S025 | `/activity` · `/activity` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S026 | `/pnl` · `/pnl` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S027 | `/disposals` · `/disposals` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S028 | `/export` · `/export` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S029 | `/asset/[symbol]` · `/asset/WETH` (also `/asset/BTC`, `/asset/NVDAc`) | No (position rows need a session) | Not run | Not run | UNTESTED (owner sign-in) |
| S030 | `/chart/[symbol]` · `/chart/BTC` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S031 | `/order/[symbol]` · `/order/WETH?side=buy` | Yes (sheet) | Not run | Loaded content and console PASS at c566f65 (Metro, the fork executor): `WETH` sheet with `Buy` selected, `$250` and `0.0982 WETH`, pills `$100` `$500` `Max`, the keypad, `Minimum received 0.0975 WETH`, `Network fee` `On us · ≈ $0.54`, CTA `Buy $250 of WETH`. The fork answered both of the ticket's quote requests `200`, in 10.0 s and 8.0 s while the endpoint QA ran against it. No Metro error or warning. Controls not yet driven (screen locked) | UNTESTED (owner sign-in) |
| S032 | `/swap` · `/swap` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S033 | `/position/[id]` · `/position/<id from GET /positions>` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S034 | `/auto-close/[id]` · `/auto-close/<position id from GET /positions>` | Yes (sheet) | Not run | Not run | UNTESTED (owner sign-in) |
| S035 | `/limit-orders` · `/limit-orders` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S036 | `/route/[symbol]` · `/route/WETH` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S037 | `/crosschain` · `/crosschain` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S038 | `/perp/[symbol]` · `/perp/BTC` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S039 | `/futures` · `/futures` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S040 | `/funding` · `/funding` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S041 | `/markets/[classId]` · `/markets/commodities` (`crypto` `stocks` `commodities` `indices` `preipo`) | No | Not run | Not run | UNTESTED (owner sign-in) |
| S042 | `/search` · `/search` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S043 | `/watchlist` · `/watchlist` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S044 | `/movers` · `/movers` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S045 | `/stocks` · `/stocks` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S046 | `/earnings` · `/earnings` | Yes (`/market/earnings` is not public) | Not run | Not run | UNTESTED (owner sign-in) |
| S047 | `/compare` · `/compare` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S048 | `/agent/[id]` · `/agent/momentum-scout` or `/agent/<id from GET /agents>` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S049 | `/bot/roster` · `/bot/roster` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S050 | `/bot/[id]/intro` · `/bot/<id from GET /agents>/intro` | Yes (sheet) | Not run | Not run | UNTESTED (owner sign-in) |
| S051 | `/bot/[id]/settings` · `/bot/<id>/settings` | Yes (sheet) | Not run | Not run | UNTESTED (owner sign-in) |
| S052 | `/bot/[id]/backtest` · `/bot/momentum-scout/backtest` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S053 | `/bot/leaderboard` · `/bot/leaderboard` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S054 | `/roster-compare` · `/roster-compare` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S055 | `/risk` · `/risk` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S056 | `/voice` · `/voice` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S057 | `/strategies` · `/strategies` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S058 | `/strategy/[id]` · `/strategy/<id from GET /strategies>` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S059 | `/strategy/dca` · `/strategy/dca` | Yes (sheet) | Not run | Not run | UNTESTED (owner sign-in) |
| S060 | `/strategy/yield` · `/strategy/yield` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S061 | `/strategy/grid` · `/strategy/grid` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S062 | `/backtest` · `/backtest` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S063 | `/schedule` · `/schedule` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S064 | `/runs` · `/runs` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S065 | `/runs/[id]` · `/runs/<id from GET /runs>` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S066 | `/proposals` · `/proposals` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S067 | `/safety` · `/safety` | Yes (a signed-out state exists) | Not run | Not run | UNTESTED (owner sign-in) |
| S068 | `/settings` · `/settings` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S069 | `/profile` · `/profile` | Yes (sheet) | Not run | Not run | UNTESTED (owner sign-in) |
| S070 | `/delegation` · `/delegation` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S071 | `/approvals` · `/approvals` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S072 | `/policy` · `/policy` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S073 | `/allowlist` · `/allowlist` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S074 | `/recovery` · `/recovery` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S075 | `/alerts` · `/alerts` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S076 | `/alerts/new` · `/alerts/new` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S077 | `/notifications` · `/notifications` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S078 | `/basename` · `/basename` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S079 | `/legal/[doc]` · `/legal/terms` (`terms` `privacy` `risk`) | No | Not run | Not run | UNTESTED (owner sign-in) |
| S080 | `/verify` · `/verify` | No (sends the wallet when signed in) | Not run | Not run | UNTESTED (owner sign-in) |
| S081 | `/judge` · `/judge` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S082 | `/sponsors` · `/sponsors` | Partly | Not run | Not run | UNTESTED (owner sign-in) |
| S083 | `/sources` · `/sources` | Partly | Not run | Not run | UNTESTED (owner sign-in) |
| S084 | `/venues` · `/venues` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S085 | `/tokens` · `/tokens` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S086 | `/coverage` · `/coverage` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S087 | `/crosscheck/[symbol]` · `/crosscheck/WETH` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S088 | `/oracle/[symbol]` · `/oracle/NVDAc` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S089 | `/audit/chain` · `/audit/chain` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S090 | `/audit/[seq]` · `/audit/<id of a row in GET /activity>` (the value `/audit/chain` links with) | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S091 | `/audit/anchor` · `/audit/anchor` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S092 | `/graph` · `/graph` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S093 | `/graph/spends` · `/graph/spends` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S094 | `/graph/decision` · `/graph/decision` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S095 | `/metrics` · `/metrics` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S096 | `/system` · `/system` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S097 | `/network` · `/network` | No | Not run | Not run | UNTESTED (owner sign-in) |
| S098 | `/explore` · `/explore` | No | Partly run at web 2fa214a (Chrome, signed out): the Networks row (`Networks`, `Every network xorr runs on`) opens `/networks`, and back from there returns to Explore; no console message. The other rows not driven | Not run | UNTESTED (owner sign-in) |
| S099 | `/inbox` · `/inbox` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S100 | `/catchup` · `/catchup` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S101 | `/briefing` · `/briefing` | Yes | Not run | Not run | UNTESTED (owner sign-in) |
| S102 | `/networks` · `/networks` (2026-09-15; also `/network?key=base-sepolia`) | No | Loaded content, console and requests PASS at web 677d691 (Chrome for the words, a clean Chromium for every request): `/networks`, `/network?key=base-sepolia` and `/network` read as defined; each executor's `/health`, `/market/tradable` and `/yield/supply` answered 200 for the network on screen; no console error or warning. Controls PASS at web 2fa214a (Chrome, signed out): the Base Sepolia card opens `/network?key=base-sepolia` (chain 84532, block, contract `0x6c55…540e`, gas 0.0480 ETH, explorer; no `This app`, no System button), `Every network` returns to `/networks`, the Base fork card opens `/network?key=base-fork` with `This app` and `Everything the system needs`, which opens `/system`, and back returns; `/network?key=arbitrum` says `xorr does not run on arbitrum.` and its `Every network` opens `/networks`; Explore's Networks row and the chips on Deposit and Send open `/networks`. No console message. Every executor request 200. The two `HEAD` requests per route are the Coinbase Wallet SDK (loaded by Privy) reading the page's `Cross-Origin-Opener-Policy`: the same request made from the page answers 200, though the extension's request log labels it 503 | Loaded content and console PASS at 677d691 (Metro): both cards read live — Base fork `This app`, Up, block 51,242,382, trades settle, idle cash can earn; Base Sepolia Up, block 46,826,570, watch only, cannot earn — and `/network?key=base-sepolia` shows chain 84532, block, contract `0x6c55…540e`, gas 0.0480 ETH, explorer, no `This app` and no System button. Controls not yet driven (screen locked) | UNTESTED (owner sign-in) |
<!-- SCREENS:END -->

### A2. Landing site — https://xorr.finance (live since 2026-09-14)

One page, built from `landing/` (not this run's code to change: a FAIL here is reported to the owner, not fixed).

| Id | Page | Correct when | Status |
| --- | --- | --- | --- |
| L001 | `/` | 200 HTML titled `xorr — A bot that trades while you get on with your life`; the headline readable once the entrance animation ends; `Open the app` links to https://app.xorr.finance/ and `xorr on GitHub` to the repository; the three How it works tabs switch; the hero video plays; every request 2xx and nothing in the console; no horizontal scroll at desktop or phone width; an unknown path answers 404; the same five security headers the app sends; no chain named in the copy (the owner's chain-agnostic direction, 2026-09-15) | Load, links, tabs, console and every request PASS (2026-09-15, Chrome and a clean Chromium); hero video PASS in a clean Chromium (both files 206, playing), while in the owner's Chrome neither video was ever requested; unknown path 404 PASS. **FAIL** headers: only `strict-transport-security` — no X-Frame-Options, X-Content-Type-Options, Referrer-Policy or Permissions-Policy. **FAIL** copy: `Built on Base` three times and `Anchored on Base` once. Phone width PASS (2026-09-15, a clean Chromium at 402×874: no horizontal scroll at the top or the bottom of the page, the headline and `Open the app` inside the viewport, no console error or failed request) |

## B. Executor endpoints — 117 endpoints, 221 checks per executor

Per-check definitions of correct are the rows of [docs/qa/ENDPOINTS.md](qa/ENDPOINTS.md), ids E001–E221, run by
`tools/qa-full.mjs`. Status below is per executor from the last full run, then from the re-run after fixes.

<!-- ENDPOINTS:BEGIN -->
| Id | Method | Path | Auth | Fork (2026-09-14, 8c05266) | Sepolia (2026-09-14, 8c05266) | Re-run after fixes: fork c566f65 · Sepolia c566f65 |
| --- | --- | --- | --- | --- | --- | --- |
| E001 | GET | `/activity` | Privy user | PASS | PASS | PASS · PASS |
| E002 | GET | `/activity` | Privy user | PASS | PASS | PASS · PASS |
| E003 | GET | `/activity/export` | Privy user | PASS | PASS | PASS · PASS |
| E004 | GET | `/activity/export?format=json` | Privy user | PASS | PASS | PASS · PASS |
| E005 | GET | `/activity/verify` | Privy user | PASS | PASS | PASS · PASS |
| E006 | GET | `/activity/verify` | Privy user | PASS | PASS | PASS · PASS |
| E007 | GET | `/activity/verify` | Privy user | PASS | PASS | PASS · PASS |
| E008 | GET | `/agent/due` | agent key | PASS | PASS | PASS · PASS |
| E009 | GET | `/agent/keys` | agent key | PASS | PASS | PASS · PASS |
| E010 | POST | `/agent/keys` | agent key | PASS | PASS | PASS · PASS |
| E011 | DELETE | `/agent/keys/:id` | agent key | PASS | PASS | PASS · PASS |
| E012 | POST | `/agent/positions/close` | agent key | PASS | PASS | PASS · PASS |
| E013 | POST | `/agent/strategies/:id/run` | agent key | PASS | PASS | PASS · PASS |
| E014 | POST | `/agent/tick` | agent key | PASS | PASS | PASS · PASS |
| E015 | GET | `/agent/whoami` | agent key | PASS | PASS | PASS · PASS |
| E016 | GET | `/agents` | Privy user | PASS | PASS | PASS · PASS |
| E017 | GET | `/agents` | Privy user | PASS | PASS | PASS · PASS |
| E018 | POST | `/agents` | Privy user | PASS | PASS | PASS · PASS |
| E019 | POST | `/agents` | Privy user | PASS | PASS | PASS · PASS |
| E020 | DELETE | `/agents/:id` | Privy user | PASS | PASS | PASS · PASS |
| E021 | DELETE | `/agents/:id` | Privy user | PASS | PASS | PASS · PASS |
| E022 | PATCH | `/agents/:id` | Privy user | PASS | PASS | PASS · PASS |
| E023 | PATCH | `/agents/:id` | Privy user | PASS | PASS | PASS · PASS |
| E024 | GET | `/agents/:id/backtest` | Privy user | PASS | PASS | PASS · PASS |
| E025 | GET | `/agents/:id/backtest` | Privy user | FAIL | FAIL | PASS · PASS |
| E026 | GET | `/agents/:id/backtest` | Privy user | FAIL | FAIL | PASS · PASS |
| E027 | GET | `/agents/:id/backtest` | Privy user | PASS | PASS | PASS · PASS |
| E028 | GET | `/agents/leaderboard` | Privy user | PASS | PASS | PASS · PASS |
| E029 | GET | `/agents/leaderboard` | Privy user | PASS | PASS | PASS · PASS |
| E030 | POST | `/agents/resume` | Privy user | PASS | PASS | PASS · PASS |
| E031 | POST | `/agents/resume` | Privy user | PASS | PASS | PASS · PASS |
| E032 | POST | `/agents/stop` | Privy user | PASS | PASS | PASS · PASS |
| E033 | POST | `/agents/stop` | Privy user | PASS | PASS | PASS · PASS |
| E034 | GET | `/agents/stopped` | Privy user | PASS | PASS | PASS · PASS |
| E035 | GET | `/agents/stopped` | Privy user | PASS | PASS | PASS · PASS |
| E036 | GET | `/alerts` | Privy user | PASS | PASS | PASS · PASS |
| E037 | GET | `/alerts` | Privy user | PASS | PASS | PASS · PASS |
| E038 | POST | `/alerts` | Privy user | PASS | PASS | PASS · PASS |
| E039 | POST | `/alerts` | Privy user | PASS | PASS | PASS · PASS |
| E040 | POST | `/alerts` | Privy user | PASS | PASS | PASS · PASS |
| E041 | DELETE | `/alerts/:id` | Privy user | PASS | PASS | PASS · PASS |
| E042 | DELETE | `/alerts/:id` | Privy user | PASS | PASS | PASS · PASS |
| E043 | POST | `/alerts/:id` | Privy user | PASS | PASS | PASS · PASS |
| E044 | POST | `/alerts/:id` | Privy user | PASS | PASS | PASS · PASS |
| E045 | POST | `/alerts/evaluate` | Privy user | PASS | PASS | PASS · PASS |
| E046 | GET | `/approvals` | Privy user | PASS | PASS | PASS · PASS |
| E047 | GET | `/approvals` | Privy user | PASS | PASS | PASS · PASS |
| E048 | GET | `/audit/anchor` | Privy user | PASS | PASS | PASS · PASS |
| E049 | GET | `/audit/anchor` | Privy user | PASS | PASS | PASS · PASS |
| E050 | POST | `/audit/anchor` | Privy user | PASS | PASS | PASS · PASS |
| E051 | GET | `/basename` | public | PASS | PASS | PASS · PASS |
| E052 | GET | `/basename` | public | FAIL | FAIL | PASS · PASS |
| E053 | POST | `/bot/say` | Privy user | PASS | PASS | PASS · PASS |
| E054 | POST | `/bot/say` | Privy user | PASS | PASS | PASS · PASS |
| E055 | GET | `/briefing` | Privy user | PASS | PASS | PASS · PASS |
| E056 | GET | `/catchup` | Privy user | PASS | PASS | PASS · PASS |
| E057 | GET | `/catchup` | Privy user | PASS | PASS | PASS · PASS |
| E058 | POST | `/catchup/seen` | Privy user | PASS | PASS | PASS · PASS |
| E059 | GET | `/crosschain/destinations` | Privy user | PASS | PASS | PASS · PASS |
| E060 | GET | `/crosschain/destinations` | Privy user | PASS | PASS | PASS · PASS |
| E061 | GET | `/crosschain/quote` | Privy user | PASS | PASS | PASS · PASS |
| E062 | GET | `/crosschain/quote` | Privy user | PASS | PASS | PASS · PASS |
| E063 | GET | `/crosschain/quote` | Privy user | PASS | PASS | PASS · PASS |
| E064 | GET | `/delegation` | Privy user | PASS | PASS | PASS · PASS |
| E065 | GET | `/delegation` | Privy user | PASS | PASS | PASS · PASS |
| E066 | GET | `/delegation/params` | Privy user | PASS | PASS | PASS · PASS |
| E067 | GET | `/delegation/params` | Privy user | PASS | PASS | PASS · PASS |
| E068 | POST | `/delegation/record` | Privy user | PASS | PASS | PASS · PASS |
| E069 | POST | `/delegation/record` | Privy user | PASS | PASS | PASS · PASS |
| E070 | POST | `/delegation/revoke` | Privy user | PASS | PASS | PASS · PASS |
| E071 | POST | `/delegation/revoke` | Privy user | PASS | PASS | PASS · PASS |
| E072 | POST | `/devices/register` | Privy user | PASS | PASS | PASS · PASS |
| E073 | POST | `/devices/register` | Privy user | PASS | PASS | PASS · PASS |
| E074 | GET | `/disposals` | Privy user | PASS | PASS | PASS · PASS |
| E075 | GET | `/disposals` | Privy user | PASS | PASS | PASS · PASS |
| E076 | GET | `/faucet` | Privy user | PASS | PASS | PASS · PASS |
| E077 | GET | `/faucet` | Privy user | PASS | PASS | PASS · PASS |
| E078 | POST | `/faucet` | Privy user | PASS | PASS | PASS · PASS |
| E079 | POST | `/faucet` | Privy user | PASS | PASS | PASS · PASS |
| E080 | GET | `/graph/activity` | Privy user | PASS | PASS | PASS · PASS |
| E081 | GET | `/graph/activity` | Privy user | PASS | PASS | PASS · PASS |
| E082 | GET | `/graph/decision` | Privy user | PASS | PASS | PASS · PASS |
| E083 | GET | `/graph/decision` | Privy user | FAIL | FAIL | PASS · PASS |
| E084 | GET | `/graph/decision` | Privy user | PASS | PASS | PASS · PASS |
| E085 | GET | `/graph/health` | Privy user | PASS | PASS | PASS · PASS |
| E086 | GET | `/graph/health` | Privy user | PASS | PASS | PASS · PASS |
| E087 | GET | `/health` | public | PASS | PASS | PASS · PASS |
| E088 | GET | `/history` | Privy user | PASS | PASS | PASS · PASS |
| E089 | GET | `/history` | Privy user | PASS | PASS | PASS · PASS |
| E090 | GET | `/history` | Privy user | PASS | PASS | PASS · PASS |
| E091 | GET | `/limit-orders` | Privy user | PASS | PASS | PASS · PASS |
| E092 | GET | `/limit-orders` | Privy user | PASS | PASS | PASS · PASS |
| E093 | POST | `/limit-orders` | operator | PASS | PASS | PASS · PASS |
| E094 | POST | `/limit-orders/:hash/fill` | Privy user | PASS | PASS | PASS · PASS |
| E095 | POST | `/limit-orders/:hash/fill` | Privy user | PASS | PASS | PASS · PASS |
| E096 | GET | `/limits` | Privy user | FAIL | PASS | PASS · PASS |
| E097 | GET | `/limits` | Privy user | PASS | PASS | PASS · PASS |
| E098 | POST | `/limits/check` | Privy user | PASS | PASS | PASS · PASS |
| E099 | POST | `/limits/check` | Privy user | PASS | PASS | PASS · PASS |
| E100 | GET | `/market/crosscheck` | public | PASS | PASS | PASS · PASS |
| E101 | GET | `/market/crosscheck` | public | FAIL | FAIL | PASS · PASS |
| E102 | GET | `/market/earnings` | Privy user | PASS | PASS | PASS · PASS |
| E103 | GET | `/market/earnings` | Privy user | FAIL | FAIL | PASS · PASS |
| E104 | GET | `/market/earnings` | Privy user | PASS | PASS | PASS · PASS |
| E105 | GET | `/market/futures` | public | PASS | PASS | PASS · PASS |
| E106 | GET | `/market/logos` | public | FAIL | PASS | PASS · PASS |
| E107 | GET | `/market/ohlc` | public | PASS | PASS | PASS · PASS |
| E108 | GET | `/market/ohlc` | public | FAIL | FAIL | PASS · PASS |
| E109 | GET | `/market/quotes` | public | PASS | PASS | PASS · PASS |
| E110 | GET | `/market/sparklines` | public | PASS | PASS | PASS · PASS |
| E111 | GET | `/market/stocks` | public | PASS | PASS | PASS · PASS |
| E112 | GET | `/market/stocks/history` | public | PASS | PASS | PASS · PASS |
| E113 | GET | `/market/stocks/history` | public | FAIL | FAIL | PASS · PASS |
| E114 | GET | `/market/symbols` | public | PASS | PASS | PASS · PASS |
| E115 | GET | `/market/tradable` | public | PASS | PASS | PASS · PASS |
| E116 | GET | `/market/watchable` | public | PASS | PASS | PASS · PASS |
| E117 | GET | `/metrics` | public | PASS | PASS | PASS · PASS |
| E118 | GET | `/notifications/prefs` | Privy user | PASS | PASS | PASS · PASS |
| E119 | GET | `/notifications/prefs` | Privy user | PASS | PASS | PASS · PASS |
| E120 | POST | `/notifications/prefs` | Privy user | PASS | PASS | PASS · PASS |
| E121 | POST | `/notifications/prefs` | Privy user | PASS | PASS | PASS · PASS |
| E122 | POST | `/notify/test` | Privy user | PASS | PASS | PASS · PASS |
| E123 | GET | `/ops/mirror` | operator | PASS | PASS | PASS · PASS |
| E124 | POST | `/ops/mirror` | operator | PASS | PASS | PASS · PASS |
| E125 | POST | `/orders` | Privy user | PASS | PASS | PASS · PASS |
| E126 | POST | `/orders` | Privy user | PASS | PASS | PASS · PASS |
| E127 | POST | `/panic/flatten` | Privy user | PASS | PASS | PASS · PASS |
| E128 | GET | `/panic/preview` | Privy user | PASS | PASS | PASS · PASS |
| E129 | GET | `/panic/preview` | Privy user | PASS | PASS | PASS · PASS |
| E130 | GET | `/perp/:symbol` | public | PASS | PASS | PASS · PASS |
| E131 | GET | `/perp/:symbol` | public | PASS | PASS | PASS · PASS |
| E132 | GET | `/perp/:symbol/candles` | public | PASS | PASS | PASS · PASS |
| E133 | GET | `/perp/:symbol/candles` | public | PASS | PASS | PASS · PASS |
| E134 | GET | `/pnl/disposals.csv` | Privy user | PASS | PASS | PASS · PASS |
| E135 | GET | `/pnl/disposals.csv` | Privy user | PASS | PASS | PASS · PASS |
| E136 | GET | `/pnl/realised` | Privy user | PASS | PASS | PASS · PASS |
| E137 | GET | `/pnl/realised` | Privy user | PASS | PASS | PASS · PASS |
| E138 | GET | `/portfolio/history` | Privy user | PASS | PASS | PASS · PASS |
| E139 | GET | `/portfolio/history` | Privy user | PASS | PASS | PASS · PASS |
| E140 | GET | `/portfolio/history` | Privy user | PASS | PASS | PASS · PASS |
| E141 | POST | `/portfolio/snapshot` | Privy user | PASS | PASS | PASS · PASS |
| E142 | POST | `/portfolio/snapshot` | Privy user | PASS | PASS | PASS · PASS |
| E143 | GET | `/positions` | Privy user | PASS | PASS | PASS · PASS |
| E144 | GET | `/positions` | Privy user | PASS | PASS | PASS · PASS |
| E145 | GET | `/positions/:id` | Privy user | PASS | PASS | PASS · PASS |
| E146 | GET | `/positions/:id` | Privy user | PASS | PASS | PASS · PASS |
| E147 | POST | `/positions/close` | Privy user | PASS | PASS | PASS · PASS |
| E148 | POST | `/positions/close` | Privy user | PASS | PASS | PASS · PASS |
| E149 | GET | `/price/:symbol` | Privy user | PASS | PASS | PASS · PASS |
| E150 | GET | `/price/:symbol` | Privy user | FAIL | FAIL | PASS · PASS |
| E151 | GET | `/price/:symbol` | Privy user | PASS | PASS | PASS · PASS |
| E152 | GET | `/privy/policy` | Privy user | PASS | PASS | PASS · PASS |
| E153 | GET | `/privy/policy` | Privy user | PASS | PASS | PASS · PASS |
| E154 | POST | `/privy/policy/prove` | operator | PASS | PASS | PASS · PASS |
| E155 | GET | `/proposals` | Privy user | PASS | PASS | PASS · PASS |
| E156 | GET | `/proposals` | Privy user | PASS | PASS | PASS · PASS |
| E157 | POST | `/proposals` | Privy user | PASS | PASS | PASS · PASS |
| E158 | POST | `/proposals` | Privy user | PASS | PASS | PASS · PASS |
| E159 | POST | `/proposals/:id/decide` | Privy user | PASS | PASS | PASS · PASS |
| E160 | POST | `/proposals/:id/decide` | Privy user | FAIL | FAIL | PASS · PASS |
| E161 | POST | `/proposals/:id/decide` | Privy user | PASS | PASS | PASS · PASS |
| E162 | GET | `/proposals/current` | Privy user | PASS | PASS | PASS · PASS |
| E163 | GET | `/proposals/current` | Privy user | PASS | PASS | PASS · PASS |
| E164 | POST | `/proposals/generate` | Privy user | PASS | PASS | PASS · PASS |
| E165 | GET | `/route/compare` | Privy user | PASS | PASS | PASS · PASS |
| E166 | GET | `/route/compare` | Privy user | FAIL | FAIL | PASS · PASS |
| E167 | GET | `/route/compare` | Privy user | PASS | PASS | PASS · PASS |
| E168 | GET | `/runs` | Privy user | PASS | PASS | PASS · PASS |
| E169 | GET | `/runs` | Privy user | FAIL | FAIL | PASS · PASS |
| E170 | GET | `/runs` | Privy user | PASS | PASS | PASS · PASS |
| E171 | GET | `/strategies` | Privy user | FAIL | FAIL | PASS · PASS |
| E172 | GET | `/strategies` | Privy user | PASS | PASS | PASS · PASS |
| E173 | POST | `/strategies` | Privy user | FAIL | FAIL | PASS · PASS |
| E174 | POST | `/strategies` | Privy user | PASS | PASS | PASS · PASS |
| E175 | POST | `/strategies` | Privy user | PASS | PASS | PASS · PASS |
| E176 | DELETE | `/strategies/:id` | Privy user | PASS | PASS | PASS · PASS |
| E177 | DELETE | `/strategies/:id` | Privy user | PASS | PASS | PASS · PASS |
| E178 | PATCH | `/strategies/:id` | Privy user | PASS | PASS | PASS · PASS |
| E179 | PATCH | `/strategies/:id` | Privy user | PASS | PASS | PASS · PASS |
| E180 | POST | `/strategies/:id/run` | Privy user | PASS | PASS | PASS · PASS |
| E181 | POST | `/strategies/:id/run` | Privy user | PASS | PASS | PASS · PASS |
| E182 | POST | `/strategies/backtest` | Privy user | PASS | PASS | PASS · PASS |
| E183 | POST | `/strategies/backtest` | Privy user | FAIL | FAIL | PASS · PASS |
| E184 | POST | `/strategies/backtest` | Privy user | PASS | PASS | PASS · PASS |
| E185 | POST | `/swap` | Privy user | PASS | PASS | PASS · PASS |
| E186 | POST | `/swap` | Privy user | PASS | PASS | PASS · PASS |
| E187 | GET | `/swap/quote` | Privy user | FAIL | PASS | PASS · PASS |
| E188 | GET | `/swap/quote` | Privy user | FAIL | FAIL | PASS · PASS |
| E189 | GET | `/swap/quote` | Privy user | PASS | PASS | PASS · PASS |
| E190 | GET | `/verify` | public | PASS | PASS | PASS · PASS |
| E191 | GET | `/verify` | public | PASS | PASS | PASS · PASS |
| E192 | GET | `/wallet` | Privy user | PASS | PASS | PASS · PASS |
| E193 | GET | `/wallet` | Privy user | PASS | PASS | PASS · PASS |
| E194 | GET | `/wallet/balance` | Privy user | PASS | PASS | PASS · PASS |
| E195 | GET | `/wallet/balance` | Privy user | PASS | PASS | PASS · PASS |
| E196 | POST | `/wallet/connect` | Privy user | PASS | PASS | PASS · PASS |
| E197 | POST | `/wallet/connect` | Privy user | PASS | PASS | PASS · PASS |
| E198 | POST | `/wallet/create` | Privy user | PASS | PASS | PASS · PASS |
| E199 | GET | `/wallet/funds` | Privy user | PASS | PASS | PASS · PASS |
| E200 | GET | `/wallet/funds` | Privy user | PASS | PASS | PASS · PASS |
| E201 | GET | `/wallet/tokens` | Privy user | PASS | PASS | PASS · PASS |
| E202 | GET | `/wallet/tokens` | Privy user | PASS | PASS | PASS · PASS |
| E203 | GET | `/withdrawal-addresses` | Privy user | PASS | PASS | PASS · PASS |
| E204 | GET | `/withdrawal-addresses` | Privy user | PASS | PASS | PASS · PASS |
| E205 | POST | `/withdrawal-addresses` | Privy user | PASS | PASS | PASS · PASS |
| E206 | POST | `/withdrawal-addresses` | Privy user | FAIL | FAIL | PASS · PASS |
| E207 | POST | `/withdrawal-addresses` | Privy user | PASS | PASS | PASS · PASS |
| E208 | POST | `/withdrawal-addresses/check` | Privy user | PASS | PASS | PASS · PASS |
| E209 | POST | `/withdrawal-addresses/check` | Privy user | PASS | PASS | PASS · PASS |
| E210 | POST | `/withdrawal-addresses/remove` | Privy user | PASS | PASS | PASS · PASS |
| E211 | POST | `/withdrawal-addresses/remove` | Privy user | PASS | PASS | PASS · PASS |
| E212 | POST | `/withdrawals/prepare-all` | Privy user | PASS | PASS | PASS · PASS |
| E213 | POST | `/withdrawals/prepare-all` | Privy user | PASS | PASS | PASS · PASS |
| E214 | POST | `/withdrawals/record` | Privy user | PASS | PASS | PASS · PASS |
| E215 | POST | `/withdrawals/record` | Privy user | PASS | PASS | PASS · PASS |
| E216 | GET | `/yield/position` | Privy user | PASS | PASS | PASS · PASS |
| E217 | GET | `/yield/position` | Privy user | PASS | PASS | PASS · PASS |
| E218 | GET | `/yield/supply` | public | PASS | PASS | PASS · PASS |
| E219 | POST | `/yield/withdraw-calldata` | Privy user | PASS | FAIL | PASS · PASS |
| E220 | POST | `/yield/withdraw-calldata` | Privy user | FAIL | FAIL | PASS · PASS |
| E221 | POST | `/yield/withdraw-calldata` | Privy user | PASS | PASS | PASS · PASS |
<!-- ENDPOINTS:END -->

## C. On-chain interactions

Contracts: `XorrDelegation` (fork `0xc32dd8aeed3035d46c7c82a351fc5522c9d463f4`, Sepolia `0x6c5528Fd8E74a047A85bAb413856A9239E73540e`),
`XorrAuditAnchor`, `XorrAquaBook`, `XorrSwapVMBook`, `TestUSDC`, `TestVenue`.

| Id | Interaction | Correct when | Surface | Status |
| --- | --- | --- | --- | --- |
| C00 | Contract test suites | `forge test` in contracts/: every unit suite (XorrDelegation, XorrAuditAnchor) and every fork suite (XorrAquaBook, XorrSwapVM, XorrStocks against a local fork of Base) passes | Foundry | PASS (2026-09-15: unit 39/39, fork 35/35) |
| C01 | Delegation contract deployed and pinned | `eth_getCode` at the executor's `/health.delegation` is non-empty on each chain; the web bundle's pinned address equals it; `/verify` row "XorrDelegation is deployed and has code" passes with the byte count and address | Chain, web bundle, Judge | PASS (2026-09-15: 5,207 bytes at 0xc32d…63f4 on the fork and 0x6c55…540e on Sepolia, each equal to its executor's `/health.delegation`; the bundle pin checked at every web deploy; Judge row passes on the simulator) |
| C02 | `grant()` signed by the owner | After the owner signs on the permission screen: `policyOf(owner)` returns the executor's delegate, the chosen daily cap and expiry, `revoked=false`; a `Granted` event in that transaction; `/delegation` and Safety show the same cap and expiry; the subgraph indexes the grant | Native, Chain | Not run |
| C03 | `spend()` inside the permission | A strategy run fills: a `Spent` event from the delegate to an allowed venue; `spentToday(owner)` rises by the run's size; the output token reaches the owner's wallet (balance read before and after); `/runs` shows `Filled` with that tx hash | Native, API, Chain | Not run |
| C04 | Over the daily cap | A run larger than `remainingToday(owner)` is refused: the revert is `DailyCapExceeded(requested, remaining)` or the executor refuses before sending; `/runs` shows `Refused` with the sentence naming the cap; no tokens move | API, Chain | Chain PASS (2026-09-15, both chains at c566f65, `tools/prove-contract-refusals.ts`): a spend by the delegate one unit over `remainingToday`, asked with `eth_call`, reverts `DailyCapExceeded(2330000001, 2330000000)` on the fork and `DailyCapExceeded(1600000001, 1600000000)` on Sepolia; `spend` checks the cap before it pulls anything. A refused run on `/runs` not run |
| C05 | Venue not allowed | A spend to a venue the owner did not allow reverts `VenueNotAllowed(venue)`; `/verify` row "The bot can only reach venues the user allowlisted" passes with a control address denied | Judge, Chain | Chain PASS (2026-09-15, both chains, `tools/prove-contract-refusals.ts`): `isVenueAllowed(owner, 0x…dEaD)` is false, and a spend by the delegate to it reverts `VenueNotAllowed(0x…dEaD)`. The `/verify` row not re-read at c566f65 |
| C06 | After revoke or expiry | Spends revert `PolicyRevoked` / `PolicyExpired`; the scheduler marks runs refused with that reason; nothing moves | API, Chain | Chain PASS (2026-09-15, `tools/prove-contract-refusals.ts` on local anvil copies of both chains): after the owner's `revoke()` (receipt success, `revoked` true) a spend by the delegate reverts `PolicyRevoked` and `remainingToday` is 0; on a fresh copy a minute past `expiresAt`, with nothing revoked, `PolicyExpired`. The scheduler marking runs refused not run: that means ending the hosted demo's permission |
| C07 | Not the delegate | A spend from any other address reverts `NotDelegate` | Chain (anvil) | PASS (2026-09-15, both hosted chains, `tools/prove-contract-refusals.ts`): a spend sent from `0x…dEaD`, asked with `eth_call`, reverts `NotDelegate` |
| C08 | `revoke()` by the owner, with no server | The owner's revoke lands and is confirmed from the chain alone: `policyOf(owner).revoked=true` after the receipt; a stale pinned address is passed over for the contract holding the live policy; a mined transaction that revoked nothing is not taken for a stop | Chain (anvil fork of the hosted fork, `tools/prove-stop-without-server.ts`) | PASS (2026-09-14, every check) |
| C09 | `closePosition()` after revoke | Reverts `PolicyRevoked`, so stop-losses and Sell everything cannot run after a stop — and Safety's footnote says exactly that (`Stops all trading, stop-losses too. Your funds stay in your wallet.`) | Chain, Native | Chain PASS (2026-09-15, local copies of both chains, `tools/prove-contract-refusals.ts`): `closePosition()` by the delegate reverts `PolicyRevoked` after the revoke and `PolicyExpired` past expiry. Safety's footnote not read in this run |
| C10 | `setVenue()` | Toggling one venue changes `isVenueAllowed(owner, venue)` with a `VenueAllowed` event and no re-grant | — | NOT BUILT in the app (FEATURES.md #56) |
| C11 | Audit anchor | `XorrAuditAnchor.latest(anchorer, owner)` returns a non-empty head and count; the head equals the executor trail's hash at that count; `/audit/anchor` shows that block; a count going backwards reverts `CountWentBackwards` | Chain, Native, Web | Chain and API PASS (2026-09-15, both chains at c566f65, `tools/prove-contract-refusals.ts`): `latest(delegate, owner)` is the anchor `/audit/anchor` shows (fork: head `0x07fd8bfd…b4b2dc` at entry 581, block 51,242,383, 15 anchors; Sepolia: `0x33ebe1d3…0d2237` at entry 308, block 46,827,414, 31 anchors). Both executors answer `ahead` (605 and 333 entries held), which `agreement()` gives only when the row at the anchored length hashes to that head. A lower count reverts `CountWentBackwards(581, 580)` and `(308, 307)`; an empty head reverts `EmptyHead`. The Anchor screen not opened |
| C12 | Aqua book fill | A run routed to Aqua fills through `XorrAquaBook.fillForDelegation` for the active owner only; the book's balances change by the fill | API, Chain | Not run |
| C13 | SwapVM program fill | A run routed to SwapVM fills through `XorrSwapVMBook.fillForDelegation`; `hashOf(order)` matches the recorded order | API, Chain | Not run |
| C14 | Test funds | Fork faucet: USDC arrives in the owner's wallet (balance before/after) with an Activity row; Sepolia: `TestUSDC.mint` to the owner; a second claim inside the window is refused with the time it opens again | Native, API | Not run |
| C15 | Token approval revoke | On Approvals, `Revoke` sends `approve(spender, 0)` signed by the owner; `allowance(owner, spender)` reads 0 after the receipt; the row disappears or reads `Limited` → gone | Native, Chain | Not run |
| C16 | User-signed transfer | Send to an allowlisted address: a transfer signed by the owner's wallet is mined; the recipient's balance rises by the amount; Activity records it; a non-allowlisted address is refused before signing | Native, Chain | Not run |

## D. External integrations

| Id | Integration | Correct when | Surface | Status |
| --- | --- | --- | --- | --- |
| I01 | Privy auth | Server verifies Privy access tokens: no token or a forged one → `401 {error:"unauthorized"}`; a real token → the account's data. Email code: a wrong code shows `That code is not right. Check it and try again.`, an expired one `That code has expired. Ask for a new one.` | API, Native | API PASS (2026-09-15, both executors at c566f65 and at 2fa214a, `tools/qa-full.mjs`): every signed-in endpoint answers 401 `unauthorized` with no token and with a forged one, and the owner's real token reads the account. The email-code screens UNTESTED: a code is the owner's to type |
| I02 | Privy embedded wallet | Sign-in yields the same wallet on every device; Profile shows `Wallet made with your email`; the wallet signs grant, revoke, approvals and transfers (C02, C08, C15, C16) | Native | Not run |
| I03 | Privy wallet policy | `/privy/policy` read shows the policy state on Safety (`Wallet policy On/Off`); a failed read shows `—`, never drops the row | Native, API | Not run |
| I04 | 1inch aggregator | `/swap/quote?in=USDC&out=WETH&amount=20&slippage=0.5` → 200 with a positive output and a route; a strategy fill through it records `1inch` as venue | API, Native | API PASS (2026-09-15): E187 on both executors at c566f65 and 2fa214a (the fork: 20 USDC → 0.007836 WETH via Uniswap V3), and the fork's public `/metrics` records 53 fills with venue `1inch`. Native: the order ticket's quote rows read from it at c566f65 (S031) |
| I05 | 1inch Aqua and SwapVM | Books open on the fork (C12, C13); `/route/compare` names every venue with an amount or a reason | API | The comparison PASS (E165 on both executors at c566f65 and 2fa214a: Aqua named as not deep enough, SwapVM and 1inch with amounts, net of gas), and the fork's `/metrics` records 8 Aqua and 12 SwapVM fills. A fill through each book today (C12, C13) not run |
| I06 | 1inch limit orders | `/limit-orders` lists orders with take amounts or `No limit orders`; publishing is operator-only | API, Native | Not run |
| I07 | 1inch cross-chain quotes | `/crosschain` returns a quote or a named refusal (`quoter_refused`); the screen says `Quotes only` | API, Native | PASS (2026-09-15): E061 on both executors at 2fa214a (100 USDC → 99.900124 on Arbitrum, 0.05 WETH quoted to Optimism), and the Cross-chain screen says Quotes only on native at 7030758 (F21) |
| I08 | 1inch token list and logos | `/tokens` lists tradable tokens with addresses; `/market/logos` returns https URLs or null per symbol | API, Native | API PASS (2026-09-15, both executors at c566f65 and 2fa214a): E106 answers BTC from CoinGecko, WETH and NVDAc from 1inch and an unknown symbol null, and the `/tokens` checks pass (docs/qa/ENDPOINTS.md) |
| I09 | CoinGecko prices | `/market/quotes` prices BTC and ETH within 2% of CoinGecko's own simple-price read at the same minute; history and OHLC answer for 1H/4H/1D | API, Native, Web | Prices PASS (2026-09-15 22:51:33 UTC): the fork's BTC $78,588 and ETH $2,535.83, and Sepolia's $78,591 and $2,535.66, against CoinGecko's own simple-price read in the same second ($78,584 and $2,535.47): all within 0.015%. OHLC: E107 passes on both executors. The 1H and 4H chart ranges not checked here |
| I10 | The Graph subgraphs | Grants, spends and revokes for the owner appear in the subgraph; `/graph/spends` matches `/runs` fills; `/graph/decision` states whether the index is fresh enough to use | API, Native | Partly run (2026-09-15, both executors at 2fa214a): `/graph/health` answers `healthy` at block 46,829,184, indexing this deployment on Sepolia and not on the fork, whose `/graph/decision` says `index_is_for_another_deployment` (E082). Spends are served at `/graph/activity`; the row's `/graph/spends` is a screen. The match between fills and indexed spends is UNTESTED: no deployment has both. The Graph cannot index a private fork, and nothing fills on Sepolia (0 filled runs there, 76 on the fork) |
| I11 | Base RPC | Sepolia: `/health` reports `base-sepolia` and the block advances between two reads seconds apart. Fork: `/health` reports `base-fork`, the node answers chain id 8453 with the deployed contracts' code, and the block advances when a transaction lands (the fork is an anvil node that mines per transaction, so an idle fork's block standing still is correct — the first draft of this row said "a minute apart", which is wrong for anvil); Judge row "The app is talking to a real chain" passes | API, Chain, Judge | Sepolia PASS (2026-09-15: 46819272 → 46819275 in 6 s). Fork: chain and code PASS; block-on-transaction pending F04 |
| I12 | Hyperliquid funding | `/market/futures` returns each contract's mark and funding rate as the venue reports them (E105); `/funding` renders them | API, Native | API PASS (2026-09-15, both executors at 2fa214a): BTC's `fundingRate` 0.0000095942 and mark 78,542 equal Hyperliquid's own `metaAndAssetCtxs` read in the same second, under venue `Hyperliquid`. The first draft of this row named `/market/funding`, which does not exist, and asked for a timestamp. Neither the endpoint's contract nor the Funding screen (S040) has one. A rate is at most 15 s old, or at most 5 minutes old when the venue stops answering, which is how prices are held too (`server/src/http/patience.ts`). The Funding screen not opened in this run |
| I13 | SEC EDGAR | `/market/earnings?symbol=NVDAc` returns the dates the company filed its results (8-K Item 2.02), as the regulator records them; a non-equity symbol is refused by name | API, Native | API PASS (2026-09-15, both executors at 2fa214a): NVDAc's `reported` dates are exactly EDGAR's own 8-K Item 2.02 filing dates for CIK 1045810, read independently: 2026-08-26, 2026-05-20, 2026-02-25, 2025-11-19, 2025-08-27, 2025-05-28, 2025-02-26 and 2024-11-20. The median gap is 91 days and the next is projected for 2026-11-25. `?symbol=BTC` is 404 `not_an_equity`, naming BTC. The first draft of this row asked for links. Neither the endpoint's contract nor the Earnings screen's row (S046) has them, and the screens name no vendor (O3). The Earnings screen rendered on native at 7030758 |
| I14 | News feeds | Headlines on Briefing link to their sources | API, Native | Not run |
| I15 | Language model (OpenRouter) | `/bot/say` and Briefing takes answer | — | UNTESTED — no `OPENROUTER_API_KEY` exists on either executor or in the local env (2026-09-15: `/health` reports `voice.configured` false on both at 7030758), so every ask is refused with `no_key`. What is tested is the refusal: the app says the build has no language model, and a conversation offers the agent's screens instead of questions (F23). Needs the owner's key |
| I16 | Expo push | A registered device receives a push for a fill | — | UNTESTED — the build has no EAS project id, so Expo issues no push token; needs a real device and an EAS project |
| I17 | Basenames | `/basename?address=` resolves a name or answers null; a bad address is a named 400 | API, Native | API PASS (2026-09-15, both executors at 2fa214a): `/basename?address=nope` is 400 `invalid_query` with a sentence, and the address and name reads pass (docs/qa/ENDPOINTS.md). The Basename screen not opened |
| I18 | Persistence | A strategy created in the app survives an executor restart and a reload; the audit trail keeps growing and re-hashes (`/audit/chain`) | API, Native | API PASS (2026-09-15). `/strategies` was read on both executors at 22:51 UTC, before 35556a1 restarted them (fork up 719 s and Sepolia 653 s when read again). All 157 fork strategies and all 52 on Sepolia came back, each with the same created time, state and kind; the fork's only additions were 3 made by the endpoint QA since. The trail kept growing and re-hashing through the runs: `/activity/verify` went from 580 to 605 rows on the fork and from 333 to 358 on Sepolia, with its link breaks unchanged (0, and Sepolia's one known fork at entry 2). A strategy created in the app and reloaded there not run (it needs the owner signed in) |
| I19 | Vercel hosting | G5 holds on the live deployment | Web | PASS at the HTTP level (2026-09-15, build 2c33e43: all 101 routes answer 200 with the app's bundle; the five headers present; manifest `application/manifest+json`, three icons `image/png`). Rendering per route is section A |
| I20 | Railway hosting | Each executor's `/health` is `ok` and its `version` equals the commit deployed; Settings shows one commit when the server code matches | API, Web | Not run |

## E. Flows

Each flow runs end to end on the named surface, then its edge cases.

| Id | Flow | Correct when | Edge cases and what correct means for each | Surface | Status |
| --- | --- | --- | --- | --- | --- |
| F01 | Sign in, new or returning | Welcome → Get started → goals → email → code → the wallet appears → Fund → permission → Home with a real balance; `POST /wallet/connect` 200 | Bad email: `That email does not look right…`; wrong code and expired code as I01; executor 5xx while registering: `We could not reach xorr just now. Your wallet is fine. Try again in a moment.` with `Try again`; a timeout says it may still be going through | Native (returning), Web | UNTESTED for a fresh sign-in — needs an email code typed by the owner |
| F02 | Session survives a relaunch | Kill and relaunch: Home, same wallet, no onboarding flash | Offline relaunch: errors are failures (G2), not an empty account | Native | Not run |
| F03 | Sign out | Settings → Sign out → confirm: `/welcome`; the device forgets the person (wallet, recovery "Done", stop switch, onboarding answers) and keeps device preferences | Next account on the device sees no trace of the last | Unit (`src/state/store.test.ts`); Native | UNTESTED on device — signing out ends the only signed-in session this run can hold |
| F04 | Fund | Deposit shows the wallet's full address and a real balance; the faucet claim lands (C14); the balance rises by the claim | Claim again inside the window: refused with when it opens; failed balance read: `—` | Native, API | Not run |
| F05 | Grant the permission | Permission screen → cap and term → Sign → approvals then grant signed → Safety `LIVE`, `Trading is live`, the cap and expiry as chosen (C02) | Grant pointed at a contract the build does not pin: refused before signing; interrupted before the signature: nothing changed on chain and Safety still reads the chain's state | Native, Chain | Not run |
| F06 | Stop and resume | Safety → Stop all trading → signed revoke → `STOPPED`, `Trading is stopped`, `Nothing trades until you resume.`; runs refuse with `PolicyRevoked`; Resume trading → re-grant from the chain's last plan → `LIVE` | Executor unreachable: the stop still offered from the chain and confirmed from the chain (C08; UI part is FEATURES.md #1); Face ID not enrolled: no prompt, as designed | Native, Chain | Not run |
| F07 | Recurring buy | Strategy → recurring buy → token, amount, cadence → start → listed live with its next runs → Run now fills (C03) → Runs `Filled` with tx → Activity row | Amount over the cap: refused with the cap; token outside the allowed set: not offered; run fails at the venue: `Failed` with the venue's sentence | Native, API | Not run |
| F08 | Order, buy and sell | Order ticket → amount → units from the live price → Place → fill → holding rises; Sell → holding falls | Sell more than held: refused before sending; price read failed: units show `—`; timeout: says it may still be going through | Native | Not run |
| F09 | Swap | Swap USDC → WETH → quote → review → swap → balances change by the quote within slippage | Over balance: button disabled with the balance; quote refused: the venue's sentence; failed price read: `—` | Native | Not run |
| F10 | Sell everything to cash | Flatten → preview lists each position and what it would sell for → confirm → positions closed, cash up | After a stop: says it cannot run and why (C09) | Native | Not run |
| F11 | Withdraw and send | Allowlist an address → Send an amount → signed transfer mined (C16) → Activity; Withdraw everything walks sell then send | Address not 0x + 40 hex: refused; not allowlisted: refused before signing; over balance: disabled | Native, Chain | Not run |
| F12 | Alerts | New alert on a symbol and level → listed on Alerts; when crossed, an Inbox row | Level not a number: refused; delete: gone after reload | Native, API | Not run |
| F13 | Proposals | A proposal shows entry, stop, target and a live expiry; Approve fills; Skip declines; untouched it expires | Another account's proposal id: 404 | Native, API | Not run |
| F14 | Agents | Roster → an agent → Get started hires it → Home shows it hired; its backtest runs on real past prices; leaderboard ranks by real P&L | Backtest with a bad lookback: named refusal | Native, API | Not run |
| F15 | Proof | Check it yourself (Judge) and Verify run every claim live with observed values (20 pass, 1 skip with its reason on the fork); Audit chain re-hashes the trail; Anchor shows the head on chain at a block; Export produces the trail | Signed out: Judge and Verify still run; an address typed into Judge reruns for that address | Web (signed out), Native | Native at 7030758: Judge 20/21 verified with 1 skipped; Verify 20 passed, 0 failed, 1 not asked. Audit chain, Anchor and Export not yet opened; the signed-out and typed-address cases not yet run |
| F16 | Recovery | Recovery shows the account email; `I can open this email` marks Recovery `Done` on Safety and Settings | Web: Export private key opens Privy's window | Native; Web | Native at 7030758: the email and `I can open this email` are shown; marking Done needs a tap, not yet driven. Web export UNTESTED — needs the owner signed in |
| F17 | Approvals | Approvals lists each token allowance to the delegation; Revoke zeroes it (C15) | Revoke declined in the wallet: nothing changes, the row stays | Native, Chain | Not run |
| F18 | Markets and assets | Markets lists classes with live prices or quiet dashes; Asset shows name, price and a chart for real ranges; Chart pills 1H 4H 1D draw their own candles | Symbol with no feed: `No chart yet.`; unknown route: the app's own 404 `There is nothing here` | Web, Native | Partly run at web 2fa214a (Chrome, signed out). Markets lists Crypto, Stocks, Commodities, Indices and Pre-IPO; on Commodities, XAUT reads $4,297 −0.89% and the eight unfed rows read `—`. `/asset/BTC` shows Bitcoin, $78,557, `up 2.4% today`, Candles and Line, and the pills 1D 1W 1M 1Y. `/chart/BTC` shows BTC/USD $78,571, +0.82%, `+$638.00 past 12 hours` and the pills 1H 4H 1D. `/definitely-not-a-route` shows the app's own `Not found` and `There is nothing here`. A symbol with no feed (`/asset/NOPE`) reads `—` and `No price feed.` with no chart, as S029 defines for no price; its `No chart yet.` is for a price with no series, so this row's edge case was drafted against the wrong state. Found: a chart's draw-in could log a negative `<rect>` width on the asset screen (the web sweep at 2fa214a on `/asset/WETH`, and one of four fresh loads of `/asset/BTC`). Fixed in 47359c0, to be verified once it ships. Pill switching and a candle tap not driven: clicks did not reach the page reliably with the display locked |
| F19 | Portfolio | Total balance equals wallet holdings priced live; the graph draws recorded snapshots for its ranges; positions and profit shown | A zero snapshot never spikes the line | Native | **FAIL** at 7030758 (native): the total ($26,026.86), the positions and their profit show, but the graph dips to $0 once — a true reading of the fork just after it was rebuilt (execution log), not a failed read. It clears when the pre-rebuild snapshots leave the fork's database, which is the owner's call |
| F20 | Settings and version | Settings rows open their screens; Version shows the web build's commit (one commit when the server code matches) | Executor unreachable: `Development build`/commit only, no warning | Web, Native | Native at 7030758: the rows render (address, recovery, permission, daily cap, allowlist, voice, alerts, terms). The Version row is below the fold, and opening rows needs taps, not yet driven |
| F21 | Limit orders and cross-chain | Limit orders lists real orders or `No limit orders`; cross-chain returns a quote or a named refusal, marked quotes only | — | Native, API | Native at 7030758: Limit orders lists an open order with Take and a taken one; Cross-chain renders, marked Quotes only. The cross-chain endpoint checks pass on both executors at 7030758; a quote for an amount typed on the screen not yet driven |
| F22 | Voice | Voice screen opens and describes itself; speaking needs a device microphone | — | Native | PASS for the screen on native at 7030758: it opens and describes each tone. Speaking UNTESTED — the simulator has no microphone |
| F23 | Messages (2026-09-15) | The bar holds Home, Swap and Messages. Swap opens the swap sheet from the bottom. Messages raises the drawer over the current screen: your avatar (Profile), search, add, the agents as faced orbs, then a row per conversation with its last line, time and a dot when something is new. A row or an orb opens that agent's conversation; a question gets the model's reply; Add hires the agent (`POST /agents`) and opens its conversation; the header's avatar opens the picker to talk to another agent | No model (`/health` `voice.configured` false): the empty conversation says it cannot reply and offers the agent's screens instead of questions, and a question typed anyway is told why; a request that never arrived says so, not that there is no model; a screen opened from the drawer (Profile, a shortcut) brings the drawer back where it was on return; search with no match: `Nothing matches “…”.`; signed out: the sign-in card and no private request | Native | PASS for the bar, the drawer's list, search, add, a question and its reply, Profile, the swap sheet and the no-model conversation (execution log). Not yet driven: switching agents from the picker, opening a shortcut, the drawer's return |

## Execution log

Runs are appended here with date, commit, surface and result counts.

| When | Build | Surface | What ran | Result |
| --- | --- | --- | --- | --- |
| 2026-09-15 | contracts at 00c41ef | Foundry | `forge test` unit and fork suites | 74/74 pass |
| 2026-09-15 | executors 8c05266 | Chain | C01 code and pins; I11 blocks | PASS (fork block rule corrected, see I11) |
| 2026-09-15 | web 2c33e43 | HTTP | I19: 101 routes, headers, manifest, icons | PASS |
| 2026-09-15 | executor-fork 8c05266 | API | `tools/qa-full.mjs`, 221 checks, before this run's server fixes | 199 pass, 22 fail. Newly failing against the 2026-09-14 run: E082 `/graph/decision`, E128 `/panic/preview`, E194 `/wallet/balance` — no response within 60 s (the app waits 45 s). Newly passing: E096, E106, E219 |
| 2026-09-15 | native, Metro main tree at b0ae828 | Native | Every route in `tools/shoot.mjs` (106) opened by deep link on the signed-in simulator, Metro's device log read after each | 106 opened; no error, TypeError or unresolved module logged for any route. Screens reviewed after the merged build, below |
| 2026-09-15 | web 00c41ef | Chrome | — | Claude in Chrome not connected after the machine restarted; signed-out web items run in the app's built-in Chromium (console and network read the same way) until it reconnects |
| 2026-09-15 | executors 608fbb2 | API | `tools/qa-full.mjs`, 221 checks on each executor | Fork 221/221. Sepolia 220/221: E149 `GET /price/BTC` gave no answer inside 60 s on a cold price cache (27 s when probed again; WETH and NVDAc under 1 s). Fixed in 9a47ece: the route waits a screen's patience, then answers `503 warming` |
| 2026-09-15 | web 00c41ef | Chromium (built in) | `tools/web-sweep.mjs`, all 101 routes signed out | 101 loaded; 0 console errors, 0 warnings, 0 page errors, 0 failed or 4xx/5xx requests |
| 2026-09-15 | native, Metro main tree at cfc8420 then 7030758 | Native | Messages end to end on the simulator (F23) | Observed: the bar (Home, Swap, Messages); the drawer's list with faced orbs, last lines and times; search "yield" finds Yield Keeper; Add hires Earnings Desk (`/agents` hired true, Home shows Hired) and opens its conversation; a starter asked gets the honest no-model reply, and the list row moves to the top with that line and time; the avatar opens Profile; Swap from the bar opens the sheet and Close dismisses it; the agent picker opens from the conversation header. Found and fixed (9a47ece, 7030758): every starter question dead-ended with no model; a request that never arrived was reported as a missing model; Profile closed the drawer for good; search and add drew plain avatars. After the fix, Drawdown Guard's empty conversation says it cannot reply here and offers How it trades, Agent limits and All runs. Not yet driven (screen locked): switching agents from the picker, a shortcut, the drawer's return |
| 2026-09-15 | native at 7030758 | Native | `/perp/BTC`, which an earlier sweep drew with two candles | PASS: 1D draws a day of hourly candles; the API answers 24 for 1D and 42 for 1W |
| 2026-09-15 | executors 7030758 | API | `/health` on both | Fork `ok` at 7030758, degraded only by the subgraph dependency (it indexes the Sepolia contract; The Graph cannot index a private fork); Sepolia `up` at 7030758. Both report `voice.configured` false: no `OPENROUTER_API_KEY` is set on either executor |
| 2026-09-15 | executors 7030758 | API | `tools/qa-full.mjs`, 221 checks on each executor | Fork 220/221: E165 `GET /route/compare` took 46.2 s, past the app's 45 s, while SwapVM and 1inch both served. Probed again: one ask gave no answer inside 90 s, the next answered in 4.3 s, another in 8.2 s with no venue serving because 1inch's route reverted on a fork about 40 hours behind Base. Cause: the comparison asked its venues one after another with no bound and read four prices without a deadline. Fixed in 089b870 (a 25 s bound, independent legs started together, a late venue reported as late); re-run after its deploy. Sepolia 221/221, E149 included |
| 2026-09-15 | native, Metro main tree at 7030758 | Native | 18 routes by deep link, each on a fresh launch: portfolio, settings, safety, judge, verify, recovery, approvals, alerts, proposals, runs, risk, earnings, rates, movers, agent/momentum-scout, limit-orders, crosschain, voice | All 18 rendered, with no Metro error or warning beyond the known `@noble/hashes` exports notice. Judge 20/21 verified, 1 skipped; Verify 20 passed, 0 failed, 1 not asked; Safety live at 17% of the cap with 5 days left; Limit orders lists an open order with Take and a taken one; Cross-chain says Quotes only; Earnings, Rate, Movers, Risk limits and the agent page, the shortcuts' destinations, render their records. Found: Portfolio's graph dips to $0 once (F19, next row); Settings and Voice described tones for a voice this build does not have (fixed, shipping); Proposals and Runs carry the endpoint QA's own rows (`qa-full`, `QA — daily WETH`) on the demo account; Approvals prints raw allowances under the amounts |
| 2026-09-15 | executor-fork 7030758 | API | `/portfolio/history?range=ALL`, the point under Portfolio's dip | One interval snapshot of $0 at 2026-09-13 04:32 UTC, between $24,999.76 at 04:16 and exactly $25,000.00 at 04:47: the fork rebuilt and funded again, read truly by a writer that keeps nothing it cannot read in full. Not a failed read. The points before it belong to a chain that no longer exists; removing them from the fork's database is the owner's call |
| 2026-09-15 | executors c8e9c52 | API | `tools/qa-full.mjs`, 221 checks on each executor | Fork 220/221: E165 `GET /route/compare` PASS after 089b870 (Aqua named as not deep enough, SwapVM and 1inch served, net of gas). **FAIL** E187 `GET /swap/quote`: no answer inside 60 s (60,004 ms). The fork's log has that request answering `200` after 97,492 ms, and while it waited `/verify`'s eight-second price check ran out twice. Asked again, it answered in under a second with a correct body. Cause: the quote, the gas price and ETH's price for the fee had no deadline. Fixed in c566f65; re-run after its deploy. Sepolia 221/221, E149 and E165 included |
| 2026-09-15 | executors c8e9c52 | API | E106 `GET /market/logos`, the first ask after each executor restarted | PASS on both: BTC has its image on the first ask, because the logo batch is warmed first at boot (c8e9c52) |
| 2026-09-15 | executors c8e9c52 | Railway deploy log | Boot lines of both executors | PASS: the migration names its database with the password masked (4494dee). Before it, the deploy log printed the connection URL whole, so rotating both Railway Postgres passwords is the owner's call |
| 2026-09-15 | web 677d691 | HTTP, Chrome, Chromium, native | Networks (S102), the network chip on Deposit, Send and Fund | The hosted bundle names 677d691 and pins the fork's delegation contract; the five security headers are present. `/networks`, `/network?key=base-sepolia` and `/network` PASS for load, content, console and requests (S102). On the simulator both cards read live. Controls not yet driven |
| 2026-09-15 | landing, Vercel `xorr-landing` | Chrome, Chromium | L001 | Load, links, tabs, hero video, unknown path and phone width PASS. **FAIL** headers (only HSTS) and **FAIL** copy (`Built on Base` three times, `Anchored on Base` once): `landing/` is not this run's code, so both go to the owner |
| 2026-09-15 | executors c566f65 | API | `tools/qa-full.mjs`, 221 checks on each executor | Fork 221/221 and Sepolia 221/221. E187 `GET /swap/quote` PASS on both, with no attempt at 45 s or more: the fork quoted 20 USDC → 0.007836 WETH via Uniswap V3, and Sepolia 0.007814 WETH via Best of 3 venues. E082, E128, E149, E165 and E194 held |
| 2026-09-15 | contracts as deployed, executors c566f65 | Chain | `tools/prove-contract-refusals.ts` (new): each chain read at one block and asked with `eth_call`; the revoke and expiry cases on a local anvil copy of each chain. Nothing sent to a hosted chain | Every check passed on both chains: C04, C05, C06, C07, C09, C11 (section C) |
| 2026-09-15 | native, Metro main tree at c566f65, fork executor c566f65 | Native | `/order/WETH` by deep link (S031), a consumer of the swap quote | Loaded content and console PASS: `Minimum received 0.0975 WETH`, `Network fee On us · ≈ $0.54`. The fork answered both quote requests `200`, in 10.0 s and 8.0 s while the endpoint QA ran. Taps not possible: the Mac's screen locked again |
| 2026-09-15 | web c566f65 | Chromium (built in) | `tools/web-sweep.mjs`, all 103 routes signed out (S102's two included) | 103 loaded; 0 console errors, 0 warnings, 0 page errors, 0 failed or 4xx/5xx requests |
| 2026-09-15 | executors 2fa214a | API | `tools/qa-full.mjs`, 221 checks on each executor, after the money guards shipped | Fork 221/221 and Sepolia 221/221, the faucet, gas and verification checks included |
| 2026-09-15 | native, Metro main tree at 2fa214a | Native | `/deposit` by deep link, after `src/chain.ts` became records keyed by chain | Loaded content and console PASS (S015): the chip still reads `Base fork · Test` and the deposit note `Test network. Use test funds.`; no Metro error |
| 2026-09-15 | web 2fa214a | Chrome | Networks and Network controls, the unknown-key state, System, Explore's Networks row, the network chips on Deposit, Send and Fund | Every control whose click reached the page did what its row defines (S015, S016, S098, S102). With the Mac's display locked, Chrome delivered some clicks and not others: a page-side event log showed no pointer event at all for the misses, and Fund's chip never received one, so it is not counted. The extension's request log labels `HEAD` requests 503; the Coinbase Wallet SDK's `HEAD` request, made again from the page, answered 200 |
| 2026-09-15 | executors and web 2fa214a | API, Chrome, Chromium | The integrations against their own sources; Markets, Asset, Chart and the unknown route in Chrome; chart console errors over fresh Chromium loads | I09: both executors' BTC and ETH within 0.015% of CoinGecko's own read in the same second. I12: BTC's funding rate and mark equal Hyperliquid's own read. I13: NVDAc's filing dates equal EDGAR's own 8-K Item 2.02 record. I04: the fork records 53 fills under 1inch. F18 partly run (its row). Found and fixed: a chart's draw-in logged a negative `<rect>` width on the asset screen, in the sweep and on one of four fresh loads of `/asset/BTC` (47359c0). Seen once and not reproduced: the automation Chrome profile, which holds earlier Privy and wagmi connection state, reached `/asset/BTC` by a history navigation, read `/positions` (401) and said `Your position did not load`. A fresh browser tapping Markets → BTC sent no such request and showed no error |
| 2026-09-15 | executors 35556a1 | API | `tools/qa-full.mjs`, 221 checks on each executor | Fork 218/221, Sepolia 217/221. Every failure is a subgraph read that The Graph refused with 429 (fork E080, E085, E190; Sepolia E080, E082, E085, E190), while the same query from this Mac answered 200. Nothing between 2fa214a and 35556a1 touches the subgraph; the causes on our side were that every `/health`, `/verify` and `/graph/health` queried the index with nothing waiting on a 429 (fixed in 5953559), and that `/graph/activity` answered the outage as a 500 (fixed in 75fa4a5) |
| 2026-09-15 | web 47359c0 | Vercel, Chromium | The chart fix, shipped to the web alone | Shipped during the 35556a1 QA by a queued job whose wait matched a line the job before it had already printed — a scheduling error on my side. The executor QA was not affected; the 35556a1 web sweep ran across two deploys and is not counted. Fresh loads after it: `/asset/WETH` 0 of 12 with the error, `/asset/NVDAc` 0 of 6; the `/asset/BTC` loads timed out during the deploy |
| 2026-09-15 | executors 8ffa5cd | Railway, API | The subgraph hold and cached health, shipped | Both executors up at 8ffa5cd; the web deploy failed at Vercel's upload (`write EPIPE`), so the web stayed at 47359c0, the same client code. Read at 23:32 UTC, `/health` answered in 5 ms and 2 ms with `The Graph is unreachable: 429, not asked again for another 6147s`: The Graph's own retry-after, honoured, with no query sent |
| 2026-09-15 | app 5b5d54d | Android 15 emulator, Metro, fork executor | The asset chart on Android | Blank on Android: the last-price rule and no candles or line, even with the draw-in off. react-native-svg on Android caches a clip's path the first time it draws, and a rect inside a `ClipPath` is never drawn, so the clip kept the zero width of a first render that had no box. Drawn unclipped on Android, where the clip only served the reveal: BTC 1D candles, the line, and a switch to 1W drew. Web and iOS reveal as before. |
| 2026-09-15 | executors and web 05bbad1 | Railway, Vercel, API, fork RPC | A rebalance's partial sale, the fork grant's approvals, and the release gates | The rebalance's WETH sale reverted with `SafeTransferFromFailed`: the router's calldata rounded the planner's float to wei and `closePosition` floored it, one wei apart in 42% of $10 sales (2899479; its settlement test was red before the fix). The demo wallet could not sell its cbBTC because `fork-grant.ts` approved WETH alone: approved on the fork (tx `0xa79deb11…`), and the script now approves the list the app's grant does (4a503ac). Gates: executor 887/887, app 1,599/1,599, lint and both typechecks clean. Live against the fork: portfolio-rebalance 5/5, the partial sale filling through the planner; sale-record 3/3. QA once The Graph's hold lifted: Sepolia 221/221; fork 219/221, where E064 and E096 read $111 spent today by the executor's tally and $106 by the chain's — a $5 buy logged at 00:00:23 UTC sits in a block stamped 23:55:12 the day before, because the fork's clock runs 13 minutes behind. `/verify?owner=`: fork 20 pass · 0 fail · 1 skip (equities), Sepolia 19 · 1 · 1 (the stated audit-chain fork at entry 2). Web sweep: 103 routes, none with an error or a warning. |
| 2026-09-15 | app at 05bbad1 and after, through Metro | Android 15 emulator, signed in as a Privy test account, fork executor | Every signed-in flow on a screen | Fund: 1,000 test USDC and 0.05 ETH arrived, read on chain. Permit: four signatures from the embedded wallet, nonce 0 → 4, cap $1,600 a day, USDC approved for 30 days of it and WETH and cbBTC in full. The onboarding rebalance: Run now filled 0.1087 WETH for $275. A recurring buy: created, and Run now filled $20. Order ticket: bought $10, sold $10.01. Swap: 10 USDC for 0.0040 WETH. Alerts: created and listed. Agents: hired. Backtest: a cold one-year cbBTC run rendered. Markets, the ETH asset and its 1D, 1W, 1M and 1Y charts. Portfolio total and graph. Messages: suggestions, the agent picker, a shortcut and back, and close. Proposals: approve filled $5 (−$5 on chain) and skip was recorded. Settings shows the version, and Recovery is marked done. Stop all trading, a held press: revoke signed, nonce 5, nothing left to spend; resume: one grant, nonce 6. Sell everything: 0.126419 WETH for $317.48. Withdraw: the destination is added, and the 24-hour cooling-off holds it until 2026-09-16 01:52 UTC, so no withdrawal yet. |
| 2026-09-15 | app 8aec6ad, 192c0b7, e4dc41b, b0ab09d, 132103f | Android 15 emulator | What those flows found wrong, fixed and run again there | An approve that filled told the person "That did not reach the executor, so nothing was decided. Try again.": the executor's "Bought 0.0020 WETH at $2,517.86…" went into a voice segment, which refuses numbers, inside the request's own try — twice, each a real $5 buy. It is shown as the fill now, and an outcome nobody heard back about is never said as nothing. Strategies and Alerts kept the list from before a setup closed over them, so a new recurring buy and a new alert looked unsaved. Onboarding put 30% beside "NVDAc, AAPLc and six more" on the fork, where that weight is held as cash; it says so. The strategy backtest made the person retry through a cold history fetch; it waits it out. |
| 2026-09-15 | executors 05bbad1 | API, local Postgres | Every live test file against both executors | Sepolia: 26 files passed and 4 skipped (the suites that need a chain 1inch settles on); 121 tests passed, none failed. Fork: 21 files passed; the other 9 never ran a test, because Privy refused the back-to-back test-token mints with 429 (18 refusals, no assertion failed). Those 9 were run again one at a time, 90 seconds apart. |
| 2026-09-15 | executors 05bbad1 | API | The nine fork files Privy throttled, run one at a time | Eight passed: agents 6, agent-limits 2, coverage 36, portfolio-rebalance 5, proposal-approve 3, proposal-decline 1, sale-record 3, strategy-proposal 1. SwapVM settlement failed the way its own header says it can: at no size it tried did a SwapVM program deliver the most — at $20, 0.007897 WETH from the program against 0.007904 through the aggregator — because earlier fills had moved the program along its curve. |
| 2026-09-15 | the fork | fork RPC, API | A fresh SwapVM maker, then SwapVM settlement again | A throwaway maker seeded 50,000 USDC and 20.19 WETH, 2% inside the aggregator, and shipped the book's own program through official Aqua with the SwapVM router as the app (tx `0x595e5703…`; the maker kept custody). The demo owner's permission was left as it was: `live-swapvm.ts` would have replaced it with a one-hour grant naming only the book. `swapvm-settle` then passed 3/3 against the executor at b01c85b — a buy settled through SwapVM and was sold back. |
| 2026-09-15 | executors and web b01c85b | Railway, Vercel, GitHub Actions | The final ship | Gates: app 1,603/1,603 in 162 files, executor 887/887 in 98, lint and both typechecks clean. Both executors report b01c85b; the hosted bundle names it and pins the fork's delegation, with the five security headers; CI `success`. Across the restart every strategy and run is still there: 3 paused and 13 live, 124 filled runs before and 126 after, the two added being the SwapVM test's own. Nothing under `server/` but a live test changed since 05bbad1. |
| 2026-09-15 | contracts, executors 05bbad1 | Base Sepolia, the fork, local anvil copies | The contract's refusals and the published record, again | `tools/prove-contract-refusals.ts` passed every check on both chains: `NotDelegate()`, `VenueNotAllowed(0x…dEaD)`, `DailyCapExceeded` one unit over what was left; on local copies, `PolicyRevoked()` for a spend and for a close after `revoke()` with nothing left of the day, and `PolicyExpired()` a minute past expiry; the anchor on chain equal to `/audit/anchor` (fork entry 799, Sepolia 433), with `CountWentBackwards` and `EmptyHead`. `forge test` 74/74. Sepolia's `XorrDelegation`: 5,207 bytes of code and Sourcify `exact_match` for creation and runtime; the Privy grant `0xce90642d…` status 1 from the owner. The delegation subgraph at block 46,834,636 with the chain at 46,834,638, no indexing errors. |
| 2026-09-15 | executors 05bbad1, web 05bbad1, apps from Metro | Chromium, iOS Simulator, Android 15 emulator | `/verify`, `/judge`, iOS and the rest of Android | `/verify?owner=`: fork 20 pass · 0 fail · 1 skip (equities), Sepolia 19 · 1 · 1 (the audit-chain break at entry 2). `/judge` signed out: "14/21 claims verified", each of the 7 wallet checks saying why it skipped, no console errors (two `ERR_ABORTED` route prefetches). iOS: the Simulator launched the app from Metro and rendered Networks against the fork at live blocks. Android: Networks, ETH at 1Y, Settings with its version, Recovery marked done; Stop all trading (a held press) signed `revoke()` `0x91ba23c8…` and Resume a new grant `0xc14f309c…`, both from the wallet to the delegation with status 1; Sell everything sold 0.126419 WETH for $317.48 (`0x4b85ca5e…`); a withdrawal destination added, which the cooling-off holds until 2026-09-16 01:52 UTC. |
| 2026-09-15 | executors and web b01c85b | API, Chromium | The final QA and sweep | QA: Sepolia 221/221 (a first run at 02:28 UTC met 1inch's own API answering 500 on E187 and E190; run again at 02:35, once 1inch answered, it passed) · fork 219/221 (E064, E096: the fork's clock runs 13 minutes behind, so a buy at 00:00:23 UTC counts on different days in the executor's tally and the chain's). Web sweep: 103 routes, 0 with a console error, a page error or a failed request, 0 with a warning. |
| 2026-09-15 | the fork | fork RPC | The fork's clock | A freshly mined block was stamped 313 s behind real time, the cause of the spend-tally split E064 and E096 read. `anvil_setTime` to real time at 02:58 UTC: the next block −3 s, and another 25 s later −3 s. Today's split stays in today's tallies; a spend near midnight no longer lands on different days. |
| 2026-09-15 | subgraph-aqua | Subgraph Studio | Deploying the Aqua venue subgraph | `graph codegen` and `graph build` passed and the build uploaded to IPFS (`QmctadHCDBprb9Q1Pq4oyMXjB6KcnUDHRheDRNyBA59tAJ`); `graph deploy` with the project's deploy key was refused `Subgraph not found`. The slug is created in Studio's dashboard by the wallet that owns the account. |
| 2026-09-15 | app from Metro, executor b01c85b | Android 15 emulator, fork | A demo recording with a real fill | `docs/demo/android-fork-demo.mp4`, 99 s, recorded with `screenrecord` and cut with ffmpeg: a recurring buy created ($50 of WETH, weekly) and run — Filled 0.0200 at $2,506.01, through a maker's SwapVM program (`0x54ff6977…`) — then the activity row with its transaction, `/judge` (19/21: the 1inch row did not answer within 10 s, 1inch's API failing at the time), and Stop all trading ending on STOPPED. Resumed afterwards: revoke nonce 7, grant nonce 8, $1,220 left today. |
| 2026-09-15 | executors 97ef98d, 0e193f1 | API, Railway | The policy's signing rules | After 97ef98d named every allowed call a second time for `eth_signTransaction`, Privy refused the policy write — `400 rules.13.name: Rule name must be fewer than 50 characters` on the fork, `rules.5.name` on Sepolia — and `/verify`'s `privy-policy` failed on both from 03:29 UTC, while `privy-refusal` still passed with the policy in force unchanged. 0e193f1 names them "Sign: …" and refuses a name Privy would (`privyPolicy.names.test.ts`, red before the fix). The fork deployed at 03:40 UTC; Sepolia's upload failed with a Railway 500 and deployed again at 03:44. Then the fork read 26 rules over 13 destinations and Sepolia 10 over 5, each owned by key quorum `zixx49…`. Gates at 0e193f1: executor 899/899, app 1,615/1,615 |
| 2026-09-15 | executors and web 4e6f80a | Railway, Vercel | The business treasury, shipped | Gates: executor 925/925 in 102 files, app 1,641/1,641 in 166 files, lint and both typechecks clean. Both executors report 4e6f80a; the hosted bundle names it and pins the fork's delegation, with the five security headers. The fork: `/verify?owner=` 20 pass · 0 fail · 1 skip, `privy-policy` 26 rules over 13 destinations; `GET /business/treasury` signed out answers 401 |
| 2026-09-15 | executor 4e6f80a | API | `business-treasury.live.test.ts` against the fork, as the demo owner | 6/6 at 04:33 UTC: a treasury ("Acme Treasury", `0x46E0…E8B0`) that is a Privy wallet owned by the policy's own quorum and not the operator's wallet; funded; Privy refused to sign a transfer out and nothing moved; the treasury's grant recorded from its event; the bot's $5 buy filled; revoked, and a buy after it refused `no_delegation` |
| 2026-09-15 | app from Metro, executor 4e6f80a | Android 15 emulator, signed in as a Privy test account, fork | Business, every control | Explore → Business. Create a treasury: `0xE7866722…1469`, Privy wallet `e1j6orf4…` owned by key quorum `zixx49…`, under policy `ine1szwj…` (26 rules) owned by the same quorum. Add test funds: 1,000 USDC (`0xbffc82f3…`). Let the bot trade · $50 a day: the treasury's approvals of USDC, WETH and cbBTC to the delegation (nonces 0–2: `0xdadaa2df…`, `0xb3bed0d4…`, `0xde341ac5…`) and `grant()` (`0x1a6e66a6…`, nonce 3), each signed by Privy and sent by the executor. Buy $5 of WETH: 0.0020 WETH at $2,491.96 against a maker's SwapVM program (`0xceb3abb6…`, from the bot's key). Stop trading: `revoke()` (`0x049c6963…`, nonce 4). Try to send it out: "Privy refused to sign a transfer of $995 out of the treasury.", and no transaction. Read from the fork afterwards: nonce 5, 995 USDC, 0.001997 WETH |
| 2026-09-15 | app from Metro, executor 4e6f80a | iOS Simulator, signed in as the demo owner | Business | The live test's treasury as its operator sees it: $995.00, Stopped, "Key held by Privy · Policy on", and six activity entries from Treasury created to All agents stopped |
| 2026-09-15 | executor 4e6f80a | API, Base Sepolia, Blockscout | The treasury where Privy broadcasts | Created `0x7437862D…7701`, owned by the quorum under the Sepolia policy (10 rules), with 0.002 ETH dripped for gas (`0x49023e0b…`); Privy refused to sign a transfer out. Privy broadcast `approve` for USDC `0x0110f56f…` and WETH `0x7202865b…` and `grant()` `0x9d2d8394…` (blocks 46,839,484–485), and the executor answered "Could not read your permission from the chain just now"; `revoke()` `0xacf00d2b…` landed a block later and was refused as still active. The executor's node had not reached the blocks Privy's had. Fixed in bdb85d0: the record waits, up to 20 s, for its node to show the transaction; `treasury.test.ts` stands in a node a block behind, and one still reading a revoked permission as live |
| 2026-09-15 | executors and web 4e6f80a | API, Chromium | QA and the sweep after the treasury | QA from 04:40 UTC: Sepolia 221/221; fork 219/221, the same two as before — E064 and E096 read $839 spent today by the executor's tally and $834 by the chain's, the $5 buy logged at 00:00:23 UTC in a block stamped the day before — so `/delegation/record` and `/delegation/revoke`, now `delegation/record.ts`, answer as they did. Web sweep of 104 routes, `/business` added: 0 with a console error, a page error or a failed or 4xx/5xx request, 0 with a warning |
| 2026-09-15 | executors and web bdb85d0, Base Sepolia | Railway, Vercel, API, Base Sepolia RPC | The record fix, shipped, and the treasury on Sepolia again | Gates: executor 927/927 in 102 files, app 1,643/1,643 in 166 files, lint and both typechecks clean; both executors and the hosted bundle name bdb85d0, shipped at 04:55 UTC. On Sepolia the treasury's approvals already stood, so the grant sent `grant()` alone — `0x728bf11d…` from the treasury, nonce 4, block 46,839,939 — recorded as "Trading permission granted"; then `revoke()` `0x88641cc4…`, nonce 5, block 46,839,941, recorded as "All agents stopped". Both broadcast by Privy, both in the treasury's trail |

---

## Earlier plan, kept as executed

The plan this file held before 2026-09-14 (commit 534463b), unchanged, headings demoted one level.

### Test plan

Written before execution. Every item states the SPECIFIC expected result. A pass means the real
result matches this text, with no console error and no failed request on that screen.

Target: the deployed app, `https://web-production-3e214.up.railway.app` (Base Sepolia), against the
public executor `executor-production-1659.up.railway.app`. Where an item can only be true on the
mainnet fork, that is stated and the fork deployment is used instead.

Signed in as a real Privy account with a real embedded wallet.

---

#### A · Infrastructure and chain (7)

| # | Item | Correct means |
|---|---|---|
| A1 | Hosted app reachable | `GET /` returns 200 and the app boots to `/welcome` when signed out |
| A2 | Executor (Sepolia) healthy | `/health` → `status: up`, `chain: base-sepolia`, postgres dependency `up` |
| A3 | Executor (fork) healthy | `/health` → `status: up`, `chain: base-fork`, postgres `up` |
| A4 | `XorrDelegation` deployed on Base Sepolia | `eth_getCode` returns >7000 bytes at `0xb14CF3D0…0a4e` |
| A5 | Postgres persisted, not in-memory | Audit chain re-verifies N of N rows; a row written in one session is present after an executor restart |
| A6 | Delegation subgraph synced | `_meta.hasIndexingErrors` false, block within ~10 of the Sepolia head, ≥1 policy indexed |
| A7 | Dev screens sealed in production | `/_dev/ui`, `/_dev/ui-edge`, `/_dev/fidelity`, `/_dev/boom` each redirect to `/` — no gallery, no throw button |

#### B · Core user flow, end to end (8)

| # | Item | Correct means |
|---|---|---|
| B1 | Sign in with email OTP | Privy accepts the code; all four onboarding steps turn green (Signed in / Wallet created / Network ready / Ready to fund) |
| B2 | Embedded wallet is the one used | The address shown on `/profile` is the Privy **embedded** wallet, not an injected browser extension |
| B3 | New wallet receives gas | A wallet the executor has never seen is sent 0.002 test ETH, and the trail records it |
| B4 | Grant the permission | Four Privy dialogs (3 approvals + `grant`), each confirming on Base Sepolia; no browser-extension dialog appears |
| B5 | Permission verified on chain | `/verify?owner=…` → `policy` PASS with the chosen cap, `revoked=false`, `delegate matches`; `venues` PASS "1 of 1 granted; a control address is correctly denied" |
| B6 | App reflects the grant | `/safety` shows LIVE, `/delegation` shows the cap and the embedded wallet as Owner, `/limits` shows that cap as remaining — all three agreeing |
| B7 | Kill switch revokes on chain | Pressing "Stop all agents" signs a `revoke`; `/verify` then reports `revoked=true` and `$0 left today` |
| B8 | App reflects the revoke | `/safety` shows STOPPED with the CTA changed to "Resume agents"; `/limits` shows `$0.00 cap` — both matching the chain |

#### C · Strategy lifecycle (5)

| # | Item | Correct means |
|---|---|---|
| C1 | Create a recurring buy | Strategy persists; `/strategies` count increments; `/schedule` lists it with the correct next-run date |
| C2 | Creation attributed correctly | Activity row reads "Created …" attributed to `xorr`, NOT to a persona that did not run it |
| C3 | Run now, on a chain that cannot fill | A readable sentence — "This network cannot settle trades. Prices are real; filling needs Base or a Base fork." No status code, no JSON, no truncation |
| C4 | Idempotence | Running the same strategy again in the same period returns "Already ran this period." and creates no second run |
| C5 | Real fills exist somewhere | The fork deployment reports ≥1 filled run through 1inch with a transaction hash |

#### D · Money-moving guards (6)

| # | Item | Correct means |
|---|---|---|
| D1 | Swap over balance | Amount above the held balance disables "Review swap" and states the real holding |
| D2 | Swap balance while unknown | A failed positions read shows an em dash and "tap to retry", never a confident `0.0000` |
| D3 | Order over settled cash | "That is more than the $0.00 you have settled." and the button does not submit |
| D4 | Send with empty allowlist | Blocked, with "Add a destination to your allowlist first." |
| D5 | Flatten with nothing held | "Sell everything" disabled, "Nothing to sell." stated |
| D6 | Unsettleable instrument | `/order/NVDAc` states the instrument cannot be settled on this chain and offers no order |

#### E · Data honesty (6)

| # | Item | Correct means |
|---|---|---|
| E1 | Prices are real | Crypto prices come from CoinGecko and move between loads; equity prices come from a live 1inch route |
| E2 | Simulated markets labelled | Every instrument with `feed: simulated` carries a SIMULATED tag on BOTH `/markets/:class` and `/movers` |
| E3 | Aave rate real, and gated | The APY is read from the pool; on a chain without Aave the sweep is disabled and says why |
| E4 | Cross-check | `/crosscheck/WETH` shows two independent sources and their spread |
| E5 | Index coverage stated | When the subgraph indexes a different contract than the build trades, `/history` and `/graph` say so instead of "nothing has settled" |
| E6 | Chain named correctly | `/fund` and `/tokens` name the chain this build actually settles on, with its addresses |

#### F · Proof surfaces (5)

| # | Item | Correct means |
|---|---|---|
| F1 | `/verify` public | Answers with no account; ≥13 checks pass, 0 fail |
| F2 | `/judge` in-app | Renders the same checks live with counts, and shows a skip as a skip rather than a pass |
| F3 | Audit hash chain | `/audit/chain` reports "Unbroken" and N of N rows re-hash |
| F4 | Export | Produces a file with a stated row count from a real `200` on `/activity/export` |
| F5 | Approvals read from chain | `/approvals` lists real per-token allowances and flags an unlimited one |

#### G · Edge cases and interruptions (8)

| # | Item | Correct means |
|---|---|---|
| G1 | Unknown market class | Names the classes that exist; no blank screen |
| G2 | Unknown legal document | Says the document does not exist; does NOT serve a different one |
| G3 | Unknown agent | Says the agent is not on the roster; no "Get Started" for a nonexistent agent |
| G4 | Invalid ids | `/position/999`, `/runs/999`, `/audit/999`, `/agent/999`, `/strategy/999`, `/auto-close/999` each give a specific not-found sentence |
| G5 | Permanent API refusal | `/oracle/WETH` shows the server's sentence with NO retry button and no JSON |
| G6 | Refresh mid-load | Interrupting a loading screen three times recovers with correct data and no console error |
| G7 | Double submit | Submitting twice rapidly creates exactly one record |
| G8 | Small screen | 375px wide: no horizontal overflow, guards and CTAs still legible |

#### H · Whole-surface sweep (2)

| # | Item | Correct means |
|---|---|---|
| H1 | All 93 product routes render | Every non-`_dev` route renders its real content or an honest empty state — no crash, no error boundary |
| H2 | Zero console/network errors | No console error on any screen; every executor request 2xx/204 |

#### I · Untestable here — stated, not marked pass

| # | Item | Why |
|---|---|---|
| I1 | Base mainnet settlement | Contract not deployed on mainnet; deploying spends real money |
| I2 | 1inch fills on the hosted app | 1inch has no Sepolia liquidity — real fills verified on the fork instead (C5) |
| I3 | AI chat replies from a model | No LLM key exists in the repo |
| I4 | Aqua venue subgraph | Built and pinned, but `graph deploy` needs a Studio slug that does not exist |
| I5 | SwapVM real fill | No maker has shipped a SwapVM program; contract covered by 10 fork tests |

---

### Results

Executed against the deployed app on 2026-09-09. Two items failed, were fixed at the root, and
re-verified from the start; the whole plan was then re-run.

| Section | Result |
|---|---|
| A · Infrastructure and chain | **7/7 PASS** |
| B · Core user flow | **8/8 PASS** |
| C · Strategy lifecycle | **5/5 PASS** (C2 failed first — see below) |
| D · Money-moving guards | **6/6 PASS** |
| E · Data honesty | **6/6 PASS** |
| F · Proof surfaces | **5/5 PASS** (F2 failed first — see below) |
| G · Edge cases | **7/8 PASS**, G7 not reproducible — see below |
| H · Whole-surface sweep | **2/2 PASS** |

#### The two failures, and what fixed them

**C2 — strategy creation attributed to a persona that did not run it.** The activity row read
"Created $50 of WETH, monthly · Yield Keeper". The code fix (`agentName` defaulting to `xorr`
instead of `'Yield Keeper'`) was already committed, but the executor deployment carrying it had
been stuck "Building" for 34 minutes, so the running service still had the old code. Redeployed;
a freshly created strategy now reads "Created $50 of CBBTC, weekly · xorr". The older row keeps
its original attribution, which is correct — the trail is append-only.

**F2 — /judge invented a reason for a skipped check.** The header said "1 skipped — those need a
wallet address, and none was given" while signed in with a wallet that nineteen of the twenty
checks had just used. The single skip was the tokenized-equities check, which skips because those
tokens do not function on Sepolia and says so on its own row. Wallet-gated skips identify
themselves (`No wallet on this request.`), so that sentence is now used only when it is true of
every skip; otherwise the summary points at the rows. Now reads "1 skipped — each says why on its
own row. Skipped is not passed."

#### G7 — double submit: guard verified, gesture not reproducible

Chrome's click injection stopped landing partway through this run — single coordinate clicks,
`ref` clicks, `.click()` and synthetic pointer sequences all produced no effect, on two tabs, on a
button that had accepted clicks earlier in the same session. Six attempts created zero records,
which measures the tooling and not the guard.

The guard itself was untested, so it is now: `createPressGuard` was extracted from
`useGuardedPress` — behaviour unchanged, including the 800ms hold — with 7 tests covering the case
that matters, two `take()` calls in the same tick where the second must be refused. Marked
**not verified end-to-end** rather than PASS, because the browser gesture is what the item asked for.

#### Untestable here (I1–I5) — stated, not marked pass

Unchanged from the plan: Base mainnet settlement (mainnet deploy spends real money), 1inch fills on
Sepolia (no liquidity — verified on the fork instead), the AI chat's model (no LLM key exists), the
Aqua venue subgraph (needs a Studio slug), and a SwapVM fill (no maker has shipped a program).
