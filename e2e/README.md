# End-to-end flows — PLAN.md 13.10

Maestro flows for the five journeys that matter. Run against a simulator with the app installed:

```bash
brew install maestro
npx expo run:ios          # or run:android
maestro test e2e/
```

These are the flows where a bug costs money, so each one asserts an OUTCOME, not just that a
screen rendered:

| Flow | What it proves |
|---|---|
| `01-onboarding.yaml` | install -> wallet -> funded -> delegation granted |
| `02-dca.yaml` | a recurring buy is created, appears under Strategies, and lands in Activity |
| `03-proposal.yaml` | approve -> the buttons are replaced by a fill bubble -> an audit row exists |
| `04-kill-switch.yaml` | stop -> the Bot tab dot goes dark, and the state survives a relaunch |
| `05-expiry.yaml` | an untouched proposal expires and posts a system line rather than filling |

The server-side halves of these — that a revoked delegation actually blocks a run, that a retry
cannot double-fill — are proven directly against Postgres and a real Solana runtime in
`server/src/executor/executor.chain.test.ts`, because those assertions are about state the UI
cannot see.
