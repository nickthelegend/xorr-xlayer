# Store listing — PLAN.md 14.4 / 14.5

## Positioning

**Name:** xorr
**Subtitle:** A bot that trades while you get on with your life

**Description (draft)**

> xorr runs trading strategies for you, inside limits you set.
>
> Start with a recurring buy: pick an amount, pick a day, and the bot handles it. When you trust it
> more, hand it more.
>
> - **Your keys, your wallet.** xorr never holds your money. The bot gets a separate permission to
>   trade — capped, time-limited, and revocable in one tap.
> - **See everything it did.** And everything it chose not to do. The full record exports as a file
>   you can check yourself.
> - **Stop it instantly.** One tap revokes the bot's permission on chain. Your stops stay live and
>   your positions are untouched.
>
> Trading involves risk. You can lose money. Past performance of a strategy says nothing about
> tomorrow.

**No return figures. No performance claims. No urgency.** copy.md's voice rules apply to the store
listing too — it is the first thing a user reads.

## Screenshots

Generated from the fidelity harness at the design target (402x874):
Bot chat · Strategies · Markets · Safety · Activity.

Do not screenshot a screen showing a profit. A store page whose hero is a green number sets the
expectation the disclaimer then has to fight.

## Compliance — start early, it is the long pole

Both stores apply extra scrutiny to trading and crypto apps:

- **Apple:** entity verification for finance apps; a registered legal entity in each region;
  App Review 3.1.5(b) for crypto; regional availability must match where the entity is licensed.
- **Google:** Financial Services declaration; crypto-exchange policy; per-country restrictions.

Neither can be started the week before launch. PLAN.md 14.2 (counsel on the non-custodial posture)
gates this, and it gates the release date.

## Known blockers before submission

| Blocker | Owner |
|---|---|
| Legal opinion on the non-custodial posture, per market | Counsel — PLAN.md 14.2 |
| Registered entity for store finance verification | Business |
| Delegate key moved to a KMS | Engineering — docs/SECURITY.md §2 |
| Executor authentication and rate limiting | Engineering — [G21] |
| Certificate pinning | Engineering — docs/SECURITY.md §8 |
