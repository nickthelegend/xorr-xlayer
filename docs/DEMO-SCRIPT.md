# Demo script — 1:50

Every sponsor track asks for two to four minutes of video. This is the shortest path that shows the
one thing this project is actually about: **a bot trading under a permission you can read and take
back, where every number is checkable somewhere we do not control.**

## Before recording

Record **the deployed app**, not a dev server. `tools/demo.mjs` now defaults to it:

```bash
set -a && . ./.env && set +a
E2E_PRIVY_EMAIL=test-9907@privy.io node tools/demo.mjs
```

- The default target is `https://app.xorr.finance` — the same build a stranger
  opens. The previous recording was shot against `localhost:8082`, which is how it came to show a
  product nobody else could reach; `APP_URL` still overrides if you need to.
- Viewport **402 × 874** — the design canvas. A desktop-width recording of a phone layout looks
  like a mistake. The script sets this itself.
- **Pick an account whose wallet has a permission.** The kill-switch beat is the closing frame and
  it needs something to close on: a wallet with nothing granted correctly renders no kill switch at
  all. `test-9907@privy.io` maps to `0xe609D86d…50d16b`, which has one.
- Confirm the executor is warm: `curl -s https://executor-production-1659.up.railway.app/verify | jq '.passed, .failed'`
  should read `14, 0` with no owner. A cold price cache makes the first screen show dashes for a few
  seconds.
- Have `sepolia.basescan.org` open in a second tab for the last beat.

**Fills are the one thing this recording cannot show.** 1inch has no liquidity on Sepolia, and the
app says so on `/network` rather than pretending. If the fill beat matters more than the "anyone can
open this" beat, record against the fork instead with
`APP_URL=http://localhost:8082` after starting a fork-pointed dev server — but then the URL on
screen is one only you can reach, which is the trade the previous recording made by accident.

## The beats

Timings are the pace to aim for, not a stopwatch.

### 1 · What it is — 0:00–0:12

Open on `/welcome`.

> "A bot that trades your money while you get on with your life. The interesting part isn't the
> bot. It's what stops it."

### 2 · Sign in — 0:12–0:22

Email, then the code. Privy's own flow, no interstitial of ours.

> "Sign in with Privy. It creates an embedded wallet — the keys are split so neither Privy nor we
> can reconstruct them."

Land on `/wallet`, address visible.

### 3 · The permission — 0:22–0:50 · **the centrepiece, do not rush it**

Go to `/delegate`. Let the four limits sit on screen for a beat before tapping.

> "This is the permission. Sixteen hundred dollars a day, expires on its own, only the venues I
> allowlisted — and it can never send money to an address of the bot's choosing."

Tap **Sign this permission**. Let Privy's sheet render fully.

> "Three signatures: two token approvals and the grant itself. This is my wallet asking me, not us
> telling you."

Approve through. Land back with the permission live.

### 4 · Give it a job — 0:50–1:08

`/strategy/dca`. Pick WETH, $50, weekly.

> "A recurring buy. Fifty dollars of WETH a week, inside the limits I just set."

Create it. The next three run dates are real.

### 5 · Watch it fill — 1:08–1:28 · **the money shot**

`/strategies`, tap the strategy, **Run now**.

> "That's a real fill on a Base mainnet fork, through 1inch. Here's the transaction."

Show the activity row with the hash and the units. Do not cut away before the hash is legible —
this is the beat that separates this from a mock.

### 6 · Check it yourself — 1:28–1:42

`/judge`.

> "Every claim this app makes, re-run live. The contract read from the chain, the subgraph queried,
> the venue allowlist tested against an address I never granted, the audit trail re-hashed. It
> reports failures too — that one is a known break in an append-only log, and it stays visible
> because a log you can rewrite to look clean proves nothing."

Scroll so at least one FAIL is on screen. **Do not hide it.** It is the most persuasive thing on the
page.

### 7 · Take it back — 1:42–1:50

`/safety`. Tap **Stop all agents**, approve.

> "One signature, and the bot is done. Nothing on our side is involved — and here it is on the
> block explorer."

Cut to BaseScan showing `revoked: true`. End there.

**What the automated recording actually produces here.** `tools/demo.mjs` does not tap — it records
footage to speak over, and the four Privy dialogs a real grant or revoke raises are not something it
drives. So this beat lands on whatever state the wallet is in, and the CTA is the tell:

| Wallet state | Closing frame |
|---|---|
| Permission live | red **Stop all agents** — the tap is yours to narrate or to perform live |
| Already revoked | **STOPPED · All agents stopped** with **Resume agents** — the kill switch's result rather than the act |
| **Expired** | **EXPIRED · Your permission has ended** with **Grant a new permission** |
| Nothing ever granted | no kill switch at all, and correctly so: there is nothing to stop |

The last two are the ones to avoid. Both are honest and both are weak endings.

**The current recording lands on EXPIRED, and that is worth understanding rather than working
around.** A grant runs for 24 hours; the demo account's lapsed at 13:35 on 8 September. Until this
was fixed the screen did not say so — it showed a green **Live** badge over "Agents are live", so
the recording made at 07:17 that morning was of a permission that had been dead for eighteen hours,
under a badge claiming the opposite. The fourth row exists because of that.

**To get the strongest ending, grant before recording.** It is one tap on `/safety` and four Privy
dialogs, and it must be done by the wallet's owner in a real browser — `tools/demo.mjs` does not
sign, and nothing on the server can sign for the user by design (see `/safety`: *"Nothing we hold
can attach it for you"*). Then record within the 24 hours.

## Rules

- **No narration over a loading state.** Wait for the screen, then speak.
- **Never say "would" or "in production".** Everything shown is live. If it needs a caveat, cut it.
- **Show one failure.** The `/judge` FAIL and the honest empty states are the differentiator; a demo
  where everything is green reads as staged.
- Screen recording at 60fps if possible — the app's motion is part of the design and 30fps smears
  the sheet transitions.

## Also produce

- **A 60-second silent GIF** of beats 3 → 5 → 7 (grant, fill, revoke) for the top of the README.
  Nobody clicks a video from a README.
- Link the video and the GIF from `README.md` above "Check it yourself", and from each track section
  of `docs/SUBMISSION.md`.

## What NOT to show

- The tokenized equities. They are live on Base mainnet and do not function on a fork, so the app
  correctly refuses to offer them here — explaining that costs thirty seconds and teaches nothing
  about the product.
- Anything under `/_dev/`.
- The Sepolia deployment. It is the publicly checkable one, but 1inch cannot settle there, so no
  fill will land and the demo dies at beat 5.
