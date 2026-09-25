# Submission video — the flow (OKX Dev Day 2026, X Layer track)

**Target: 3:45, hard limit 4:00.** One MP4, 1080p. Upload unlisted (YouTube) or attach, and paste the link in the form.

Two people record: **you** (the iPhone simulator parts, because sign-up needs a real email and code) and **Claude**
(everything in the browser, the stitching, captions and the final export). Every number on screen is real — the app
refuses to show anything else — so nothing is staged; if a shot goes wrong, re-take it rather than cutting around it.

<!-- MAINNET: fill after deploy -->

---

## The shots

| # | Time | What is on screen | Voice-over (say it, or it goes in as a caption) | Who |
|---|---|---|---|---|
| 1 | 0:00–0:20 | **The janitor film, OKX cut** (`~/Desktop/xorr-night-shift-xlayer.mp4`) — market closed, 3:02 a.m., the phone lights up, a trade is done; "Wall Street closes at 4. OKX doesn't." | *(the film's own sound — no voice)* | done |
| 2 | 0:20–0:32 | **Landing page** (https://xorr-xlayer-landing.vercel.app) — hero, "how it works", "Built on X Layer" | "xorr is an agent that trades tokenized US stocks on X Layer — for you, while you sleep." | Claude |
| 3 | 0:32–0:40 | **The web app** at xorr-xlayer.vercel.app — Home, the stocks list | "It runs on the web and natively on iPhone. Here it is on a phone." | Claude |
| 4 | 0:40–1:05 | **iPhone: sign up** — Get started → goals → "Continue with Google" (or email + code) → the wallet is created | "Sign in with Google, X, GitHub, email or your own wallet. A wallet is made for you — your keys, not ours." | **you** |
| 5 | 1:05–1:15 | **iPhone: test funds** — Deposit → "Get 1,000 test USDC" → the balance lands <!-- MAINNET: fill after deploy --> | "On the demo network, test funds arrive in seconds." | **you** |
| 6 | 1:15–1:45 | **iPhone: the permission** — $100 a day, 7 days → "Sign this permission" → the signatures run → Safety shows it live (sped up 4× in the edit) | "This is the whole idea: the agent trades inside an on-chain permission. A daily cap, an expiry, only the venues I allow. The contract enforces it, not us." | **you** |
| 7 | 1:45–2:25 | **iPhone: create your agent** — the + on Home's agents → Name → What it does → Works like (pick **Momentum Scout**) → Pick strategies → choose one or two (each shows 90 days of real results) → Daily limit → **Make agent** → its page opens | "Now I make my own agent. I name it, tell it what it's for, choose how it behaves, and give it strategies — each one shows what it did on real prices." | **you** |
| 8 | 2:25–2:40 | **iPhone: its own budget** — on the agent's page, Budget → **$25** → "Set budget to $25.00" → confirm in the wallet → the figure changes to $25.00, read back from the chain → Activity: "Budget set", with the transaction | "Then I give it a budget of its own — twenty-five dollars, on chain. The contract charges its trades to it and refuses anything past it. Even our bot's key can't raise it." | **you** |
| 9 | 2:40–3:05 | **The agent trades on its own** — Activity: an agent's own buy, routed through **OKX DEX** and charged to its budget → tap → why it bought, where it filled, and the transaction; its page shows the budget down by the trade | "It traded while I wasn't looking — through OKX DEX, out of its own budget — and it tells me why." | Claude |
| 10 | 3:05–3:18 | **It can't overspend** — a buy past today's cap is refused in words; the contract would refuse it anyway (an agent past its budget says so in Activity: "Skipped a trade") | "Past the cap, or past its budget, it's refused — in the app, and on chain." | Claude |
| 11 | 3:18–3:30 | **Stop all** — hold the button → "Trading stopped · confirmed on-chain" | "And one hold takes it all back. Signed by me. No server in the way." | Claude |
| 12 | 3:30–3:40 | **Check it yourself** — `/judge`: 20 of 20 claims re-checked live against the chain | "Every claim the app makes, checked against the chain — live, by anyone." | Claude |
| 13 | 3:40–3:45 | **End card** — XORR. · xorr-xlayer.vercel.app · github.com/nickthelegend/xorr-xlayer | *(music out)* | Claude |

**Shot 9 must show a fill made after its agent's budget was set.** Only then is the budget on the agent's page the one
that fill was charged to. The Momentum Scout METAx buy through OKX DEX (2026-09-25, 08:30 UTC, demo account
`test-3570`) came before budgets existed, so it cannot be shown as "out of its own budget".

---

## Your part (shots 4–8): how to record it

Claude will have the simulator open, the app installed, signed out, and pointed at the demo network before you
start. Then, in the Terminal:

```bash
xcrun simctl io booted recordVideo ~/Desktop/xorr-iphone.mov
```

Do shots 4 → 8 in one go (mistakes are fine — pause a second and redo the step; it gets cut). Press **Ctrl-C** in
the Terminal to stop. Tell Claude "recorded" and it takes it from there.

- **Sign-up:** "Continue with Google" is the cleanest on camera. Email works too — the code arrives by email.
- **Test funds:** Deposit → "Get 1,000 test USDC"; tap once and wait for the balance, it takes a few seconds.
- **Permission:** leave it at **$100 a day, 7 days**. The wallet asks you to confirm 17 times — one approval per token
  it may ever sell, then the permission. Just keep pressing Approve; the edit speeds it up.
- **Your agent:** any name, one line for "What it does", **Works like: Momentum Scout**, **Pick strategies** → one or
  two from the list, **Daily limit $50** → **Make agent**. Its page opens by itself.
- **Its budget:** on that page, under **Budget**, tap **$25** → **Set budget to $25.00** → confirm once in the wallet.
  Wait until the figure reads **$25.00**. It changes only after the chain has answered. Then open Activity to show
  "Budget set", and stop recording.

## What Claude records (shots 2, 3, 9–13)

On the web app, signed in as the demo account. It already has a permission, funds, and agents with budgets that have
traded. Recorded with `tools/record-demo.mjs` at phone size, so it cuts cleanly with the iPhone footage.

## The edit

`ffmpeg`, by Claude: the film → landing → web → your iPhone clip (sped up where the signatures run) → the web shots →
end card. Captions carry the voice-over if you would rather not speak. Checked against 4:00 before export.

---

## The form

| Field | Value |
|---|---|
| Project | xorr |
| Track | Build a Market — build with X Layer |
| Repo | https://github.com/nickthelegend/xorr-xlayer |
| Live app | https://xorr-xlayer.vercel.app |
| Landing | https://xorr-xlayer-landing.vercel.app (xorr.finance still serves the older Base site until you choose to point it here) |
| Video | the uploaded link |
| Summary | `docs/SUBMISSION.md` (the first paragraph is the short summary) |
