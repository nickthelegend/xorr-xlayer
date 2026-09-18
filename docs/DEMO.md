# Running the demo

Two deployments exist and they are good at different things. That is a property of the chains, not
an accident, and the app reports which one you are looking at rather than hiding it.

| | Base Sepolia | Base mainnet fork |
|---|---|---|
| **1inch** | quotes and prices live (asked about chain 8453) — cannot settle, no liquidity on Sepolia | **real fills**, 33 settled through the router |
| **The Graph** | **live and load-bearing** — indexes the contract this deployment spends through | indexes the Sepolia contract, so the agent refuses to read permission from it |
| **Privy** | **user signing works** — email code, embedded wallet, real signatures | Privy signs against public Base, so a user-signed transaction reverts |

**Show the product on Sepolia.** Two of three integrations are fully live, sign-in works end to
end, and every screen has real data behind it. `/sponsors` reports 1inch and The Graph green.

**Show a real trade on the fork.** It is Base mainnet state — the real router, real USDC, real Aave,
real Ondo equities, real liquidity — so a fill is genuine EVM execution. `/runs` and `/metrics` are
the receipts: 33 fills through 1inch against 5 through our own Aqua book.

`/sponsors` is the screen to open first either way. It states what each integration does here and
the number behind it, and it is capable of saying a track is *not* live on the deployment you are
looking at — which on the fork it does, naming both contracts.

## One environment where all three are live

Base mainnet. Same chain the fork copies, so 1inch fills work; a subgraph can index a public
contract, so The Graph applies; and Privy signs against real Base, so user transactions go through.

The blocker is one deployment — `docs/BASE-MAINNET.md` — and it is blocked on funding rather than
on code: `npm run readiness:base --prefix server` reports 17 checks green against the live chain and
one red, which is the delegation contract that does not exist there yet.

## Starting it locally

```bash
# executor (Sepolia)
cd server && npx tsx watch src/index.ts

# app, pointed at it
EXPO_PUBLIC_API_URL=http://localhost:8788 EXPO_PUBLIC_XORR_CHAIN=base-sepolia npx expo start --web
```

Sign in with an email; the code arrives by mail. On a desktop browser the app renders at its design
width, centred — it is a phone app and does not pretend otherwise.
