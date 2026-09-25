# Submission video — the flow (OKX Dev Day 2026, X Layer track)

**Target: 3:45, hard limit 4:00.** One MP4, 1080p. Upload unlisted (YouTube) or attach, and paste the link in the form.

Two people record: **you** (the iPhone simulator parts, because sign-up needs a real email and code, and every
signature is your own wallet's) and **Claude** (the browser shots, the stitching, captions and the final export). Every
number on screen is real — the app refuses to show anything else — so nothing is staged; if a shot goes wrong, re-take
it rather than cutting around it.

**Recorded on X Layer mainnet with real money. Every transaction is on OKLink.**

The fork sandbox at https://xorr-xlayer-demo.vercel.app is where judges try it without money: Deposit there has test
funds.

---

## The shots

| # | Time | What is on screen | Voice-over (say it, or it goes in as a caption) | Who |
|---|---|---|---|---|
| 1 | 0:00–0:20 | **The janitor film, OKX cut** (`~/Desktop/xorr-night-shift-xlayer.mp4`) — market closed, 3:02 a.m., the phone lights up, a trade is done; "Wall Street closes at 4. OKX doesn't." | *(the film's own sound — no voice)* | done |
| 2 | 0:20–0:32 | **Landing page** (https://xorr-xlayer-landing.vercel.app) — hero, "how it works", "Built on X Layer" | "xorr is an agent that trades tokenized US stocks on X Layer — for you, while you sleep." | Claude |
| 3 | 0:32–0:40 | **The web app** at xorr-xlayer.vercel.app — Home, the stocks list | "It runs on the web and natively on iPhone. Here it is on a phone." | Claude |
| 4 | 0:40–1:05 | **iPhone: sign up** — Get started → goals → "Continue with Google" (or email + code) → the wallet is created | "Sign in with Google, X, GitHub, email or your own wallet. A wallet is made for you — your keys, not ours." | **you** |
| 5 | 1:05–1:15 | **iPhone: deposit** — Deposit shows your X Layer address → from OKX, withdraw USDT (about $60–100) and a little OKB for gas on the **X Layer** network to it → it arrives as USDT0 → "Review conversion" → **Convert** (2 signatures) → USDC | "I send USDT from OKX. It lands on X Layer, and one conversion later it's USDC the agent can trade." | **you** |
| 6 | 1:15–1:45 | **iPhone: the permission** — $100 a day, 7 days → "Sign this permission" → the signatures run → Safety shows it live (sped up 4× in the edit) | "This is the whole idea: the agent trades inside an on-chain permission. A daily cap, an expiry, only the venues I allow. The contract enforces it, not us." | **you** |
| 7 | 1:45–2:25 | **iPhone: create your agent** — the + on Home's agents → Name → What it does → Works like (pick **Momentum Scout**) → Pick strategies → **one** strategy: **Weekly Tesla buy** (it shows 90 days of real results) → Each run **$25** → Daily limit **$50** → **Make agent** → its page opens | "Now I make my own agent. I name it, tell it what it's for, choose how it behaves, and give it a strategy — a weekly Tesla buy, with what it did on real prices." | **you** |
| 8 | 2:25–2:40 | **iPhone: its own budget** — on the agent's page, Budget → **$50** → "Set budget to $50.00" → confirm in the wallet → the figure changes to $50.00, read back from the chain → Activity: "Budget set", with the transaction | "Then I give it a budget of its own — fifty dollars, on chain. The contract charges its trades to it and refuses anything past it. Only I can set it." | **you** |
| 9 | 2:40–3:05 | **iPhone: it trades on its own** — stay on Activity (30–60 s; the wait is cut in the edit) → the agent's own buy appears, "$25 of TSLAx", by your agent — a real mainnet trade → tap it → why it bought, where it filled (**OKX DEX**, or Uniswap v3), and the transaction → back on the agent's page, Budget reads **$25.00** | "Within a minute it makes its first trade — out of its own budget, through OKX DEX — and tells me why. Twenty-five dollars left." | **you** |
| 10 | 3:05–3:18 | **iPhone: it can't overspend** — on TSLAx, Buy → type **$500** → the ticket refuses in words, before anything is signed (it names your balance or today's cap, whichever binds first); the contract would refuse it anyway. Don't tap anything else | "Past what I have, or what I've allowed today, it's refused before anything is signed — and the contract would refuse it anyway." | **you** |
| 11 | 3:18–3:30 | **iPhone: stop all** — hold the button → one signature → "Trading stopped · confirmed on-chain" | "And one hold takes it all back. Signed by me. No server in the way." | **you** |
| 12 | 3:30–3:40 | **Check it yourself** — `/judge?owner=<your address>` on xorr-xlayer.vercel.app: the app's claims re-checked live against X Layer mainnet, for your wallet | "Every claim the app makes, checked against the chain — live, by anyone." | Claude |
| 13 | 3:40–3:45 | **End card** — XORR. · xorr-xlayer.vercel.app · github.com/nickthelegend/xorr-xlayer | *(music out)* | Claude |

**Shot 9 is a real mainnet trade, most likely through OKX DEX:** on mainnet OKX quotes the same chain it fills on.
**If the fill names Uniswap v3, keep it.** It is the honest fallback, and the voice-over becomes "routed through OKX
DEX first".

**Shot 11 really stops trading.** The stop revokes your permission on chain. Re-grant it from Safety afterwards if you
want the agent to keep going. Claude records shot 12 before you do shot 11, so `/judge` checks a live permission; the
edit keeps the order above.

---

## Your part (shots 4–11): how to record it

The app is installed on the booted simulator, signed out. Serve it against X Layer mainnet:

```bash
npm run start:mainnet
```

Then open the app on the simulator, and start recording in another Terminal tab:

```bash
xcrun simctl io booted recordVideo ~/Desktop/xorr-iphone.mov
```

Do shots 4 → 11 in one go (mistakes are fine — pause a second and redo the step; it gets cut). Press **Ctrl-C** in
the Terminal to stop. Tell Claude "recorded" and it takes it from there.

- **Sign-up:** "Continue with Google" is the cleanest on camera. Email works too — the code arrives by email.
- **Deposit:** copy the address the Deposit screen shows. In the OKX app, withdraw **USDT** (about $60–100) and about
  **0.02 OKB** to it, both on the **X Layer** network. The OKB pays gas for your own signatures. The withdrawal
  happens in OKX, not the simulator, so record it with your phone's screen recorder if you want it in the cut. The
  USDT arrives as USDT0: tap **Review conversion** → **Convert** and confirm twice. You now hold USDC.
- **Permission:** leave it at **$100 a day, 7 days**. The wallet asks you to confirm 17 times — one approval per token
  it may ever sell, then the permission. Just keep pressing Approve; the edit speeds it up.
- **Your agent:** any name, one line for "What it does", **Works like: Momentum Scout**. Under **Pick strategies**,
  choose exactly **one**: **Weekly Tesla buy**, or any other weekly or daily buy. Two would both fire on the same tick,
  and the second would find the budget already spent. Leave **Each run** at **$25**, set **Daily limit $50**, then
  **Make agent**. Its page opens by itself.
- **Its budget:** on that page, under **Budget**, tap **$50** → **Set budget to $50.00** → confirm once in the wallet.
  Wait until the figure reads **$50.00**. It changes only after the chain has answered. Then open Activity to show
  "Budget set".
- **Its first trade:** stay on Activity and keep recording. Within about 30–60 seconds the agent's strategy runs, and
  its buy appears: "$25 of TSLAx", by your agent. Tap it to show why it bought, where it filled and the transaction.
  Then go back to the agent's page: Budget now reads **$25.00**.
- **Can't overspend:** open TSLAx → Buy → type **$500**. The ticket refuses in words, and nothing is signed. Don't tap
  anything else.
- **Stop all:** tell Claude your wallet address first (shot 12 is recorded before this), then hold the stop button and
  confirm once. Wait for "Trading stopped · confirmed on-chain". Stop recording.

## What Claude records (shots 2, 3, 12, 13)

In the browser, at phone size, so it cuts cleanly with the iPhone footage: the landing page, the mainnet web app,
`/judge?owner=<your address>` (read straight off the chain, no sign-in), and the end card.

## The edit

`ffmpeg`, by Claude: the film → landing → web → your iPhone clip, shots 4–11 (sped up where the signatures run and
where it waits for the trade) → `/judge` → end card. Captions carry the voice-over if you would rather not speak.
Checked against 4:00 before export.

---

## The form

| Field | Value |
|---|---|
| Project | xorr |
| Track | Build a Market — build with X Layer |
| Repo | https://github.com/nickthelegend/xorr-xlayer |
| Live app | https://xorr-xlayer.vercel.app (X Layer mainnet) |
| Sandbox | https://xorr-xlayer-demo.vercel.app (a fork of X Layer mainnet: test funds on Deposit, no real money) |
| Landing | https://xorr-xlayer-landing.vercel.app (xorr.finance still serves the older Base site until you choose to point it here) |
| Video | the uploaded link |
| Summary | `docs/SUBMISSION.md` (the first paragraph is the short summary) |
