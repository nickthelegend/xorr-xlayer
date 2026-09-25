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

The times are the cut, not the recording: waits and signatures are sped up or cut in the edit.

| # | Time | What is on screen | Voice-over (say it, or it goes in as a caption) | Who |
|---|---|---|---|---|
| 1 | 0:00–0:20 | **The janitor film, OKX cut** (`~/Desktop/xorr-night-shift-xlayer.mp4`) — market closed, 3:02 a.m., the phone lights up, a trade is done; "Wall Street closes at 4. OKX doesn't." | *(the film's own sound — no voice)* | done |
| 2 | 0:20–0:27 | **Landing page** (https://xorr-xlayer-landing.vercel.app) — hero, "how it works", "Built on X Layer" | "xorr is an agent that trades tokenized US stocks on X Layer — for you, while you sleep." | Claude |
| 3 | 0:27–0:32 | **The web app** at xorr-xlayer.vercel.app — Home, the stocks list | "It runs on the web and natively on iPhone. Here it is on a phone." | Claude |
| 4 | 0:32–0:50 | **iPhone: sign up** — Get started → goals → "Continue with Google" (or email + code) → the wallet is created → **Allow** notifications | "Sign in with Google, X, GitHub, email or your own wallet. A wallet is made for you — your keys, not ours." | **you** |
| 5 | 0:50–1:02 | **iPhone: deposit** — Deposit shows your X Layer address → from OKX, withdraw USDT (about $60–100) and a little OKB for gas on the **X Layer** network to it → it arrives as USDT0 → "Review conversion" → **Convert** (2 signatures) → USDC | "I send USDT from OKX. It lands on X Layer, and one conversion later it's USDC the agent can trade." | **you** |
| 6 | 1:02–1:22 | **iPhone: the permission** — $100 a day, 7 days → "Sign this permission" → the signatures run → Safety shows it live | "This is the whole idea: the agent trades inside an on-chain permission. A daily cap, an expiry, only the venues I allow. The contract enforces it, not us." | **you** |
| 7 | 1:22–1:34 | **iPhone: the market** — Stocks: Tesla, Nvidia, Apple… with live prices → TSLAx: its chart and the backing badge | "Tokenized US stocks, trading on X Layer around the clock. Every price is a live quote from the pool on chain." | **you** |
| 8 | 1:34–2:02 | **iPhone: create your agent** — the + on Home's agents → Name → What it does → Works like (pick **Momentum Scout**) → Pick strategies → **one** strategy: **Weekly Tesla buy** (it shows 90 days of real results) → Each run **$25** → Daily limit **$50** → **Make agent** → its page opens | "Now I make my own agent. I name it, tell it what it's for, choose how it behaves, and give it a strategy — a weekly Tesla buy." | **you** |
| 9 | 2:02–2:14 | **iPhone: its own budget** — on the agent's page, Budget → **$50** → "Set budget to $50.00" → confirm in the wallet → the figure changes to $50.00, read back from the chain | "Then I give it a budget of its own — fifty dollars, on chain. The contract charges its trades to it and refuses anything past it. Only I can set it." | **you** |
| 10 | 2:14–2:34 | **iPhone: the phone buzzes** — go to Home and wait → within about a minute a notification drops from the top: your agent · "Bought … TSLAx" → tap it → the row opens → tap the row: why it bought, where it filled (**OKX DEX**, or Uniswap v3), and the transaction | "Then my phone buzzes. My agent just bought Tesla — on its own, out of its own budget, through OKX DEX. And it tells me why." | **you** |
| 11 | 2:34–2:46 | **iPhone: the proof, on chain** — "View transaction ›" → OKLink opens the real X Layer transaction: Success, and the token transfers — USDC out of your wallet, TSLAx into it | "And here's the proof: the real transaction on X Layer. USDC out of my wallet, Tesla into it, in one transaction." | **you** |
| 12 | 2:46–3:04 | **iPhone: talk to it** — the Messages button on the tab bar → your agent → ask "What do you look for before you buy?" → it answers in its own voice. If an agent offers a trade, show the card, then tap **Skip** | "And I can just talk to it. It answers in its own voice — and a trade it proposes waits for my yes." | **you** |
| 13 | 3:04–3:14 | **iPhone: what it's allowed** — Holdings: the TSLAx it bought → Safety: $75 left today, the venues, the expiry → the agent's page: Budget **$25.00** | "Everything it holds, and everything it's allowed to do — seventy-five dollars left today, twenty-five in its budget." | **you** |
| 14 | 3:14–3:22 | **iPhone: it can't overspend** — on TSLAx, Buy → type **$500** → the ticket refuses in words, before anything is signed (it names your balance or today's cap, whichever binds first). Don't tap anything else | "Past what I have, or what I've allowed today, it's refused before anything is signed — and the contract would refuse it anyway." | **you** |
| 15 | 3:22–3:32 | **iPhone: stop all** — hold the button → one signature → "Trading stopped · confirmed on-chain" | "And one hold takes it all back. Signed by me. No server in the way." | **you** |
| 16 | 3:32–3:40 | **Check it yourself** — `/judge?owner=<your address>` on xorr-xlayer.vercel.app: the app's claims re-checked live against X Layer mainnet, for your wallet | "Every claim the app makes, checked against the chain — live, by anyone." | Claude |
| 17 | 3:40–3:45 | **End card** — XORR. · xorr-xlayer.vercel.app · github.com/nickthelegend/xorr-xlayer | *(music out)* | Claude |

**Shot 10's fill is a real mainnet trade, most likely through OKX DEX:** on mainnet OKX quotes the same chain it fills
on. **If it names Uniswap v3, keep it.** It is the honest fallback, and the voice-over becomes "routed through OKX DEX
first".

**Shot 10's notification is the app's own.** While the app is open, it watches its trail and raises a banner for
every new fill. The banner has the same title and sentence as the executor's push, and tapping it opens the same row.
This build has no push service, which a simulator cannot use, so the banner needs the app open. On a phone with push
set up, the same message arrives on the lock screen too.

**Shot 12 answers in the agent's voice, not with numbers.** The chat is told never to name a figure; the figures are on
the screens, read from the chain. **Never tap Approve on camera unless you mean it:** on mainnet it places the trade.

**Shot 15 really stops trading.** The stop revokes your permission on chain. Re-grant it from Safety afterwards if you
want the agent to keep going. Claude records shot 16 before you do shot 15, so `/judge` checks a live permission; the
edit keeps the order above.

---

## Your part (shots 4–15): how to record it

The app is already installed on the **"xorr-xlayer iPhone 17 Pro"** simulator: a Release build with the mainnet app
built in, so nothing else needs to run. Open it from that simulator's home screen. It starts signed out.

**Don't use the other "iPhone 17 Pro" simulator.** It belongs to the Solana recording, and both apps share one bundle
id, so this app cannot live on that device.

Start recording in the Terminal. Two simulators are booted, so the command names this one:

```bash
xcrun simctl io 7672263E-97D0-4606-B190-B9FD5193E85C recordVideo ~/Desktop/xorr-iphone.mov
```

Do shots 4 → 15 in one go (mistakes are fine — pause a second and redo the step; it gets cut). Press **Ctrl-C** in
the Terminal to stop. Tell Claude "recorded" and it takes it from there.

- **Sign-up:** "Continue with Google" is the cleanest on camera. Email works too — the code arrives by email. When the
  app asks to send notifications, tap **Allow**: shot 10 needs it.
- **Deposit:** copy the address the Deposit screen shows. In the OKX app, withdraw **USDT** (about $60–100) and about
  **0.02 OKB** to it, both on the **X Layer** network. The OKB pays gas for your own signatures. The withdrawal
  happens in OKX, not the simulator, so record it with your phone's screen recorder if you want it in the cut. The
  USDT arrives as USDT0: tap **Review conversion** → **Convert** and confirm twice. You now hold USDC.
- **Permission:** leave it at **$100 a day, 7 days**. The wallet asks you to confirm 17 times — one approval per token
  it may ever sell, then the permission. Just keep pressing Approve; the edit speeds it up.
- **The market:** open Stocks, scroll a little, open **TSLAx**, and let the chart sit for two seconds.
- **Your agent:** any name, one line for "What it does", **Works like: Momentum Scout**. Under **Pick strategies**,
  choose exactly **one**: **Weekly Tesla buy**, or any other weekly or daily buy. Two would both fire on the same tick,
  and the second would find the budget already spent. Leave **Each run** at **$25**, set **Daily limit $50**, then
  **Make agent**. Its page opens by itself.
- **Its budget:** on that page, under **Budget**, tap **$50** → **Set budget to $50.00** → confirm once in the wallet.
  Wait until the figure reads **$50.00**. It changes only after the chain has answered.
- **The buzz:** go to Home and keep recording, with the app open. Within about 30–60 seconds the agent's strategy
  runs, and a notification drops from the top: your agent · "Bought … TSLAx". Tap it, and Activity opens on that row.
  Tap the row for why it bought, where it filled and the transaction.
- **The proof:** tap **View transaction ›**. OKLink opens in the simulator's browser. Scroll to the token transfers, then
  come back to the app.
- **Talk to it:** tap the Messages button on the tab bar, pick your agent, and ask "What do you look for before you
  buy?" Wait for the answer. If an agent shows a trade card, let it sit a second, then tap **Skip**.
- **What it's allowed:** Holdings (the TSLAx), then Safety ($75 left today, the venues, the expiry), then your agent's
  page (Budget $25.00).
- **Can't overspend:** open TSLAx → Buy → type **$500**. The ticket refuses in words, and nothing is signed. Don't tap
  anything else.
- **Stop all:** tell Claude your wallet address first (shot 16 is recorded before this), then hold the stop button and
  confirm once. Wait for "Trading stopped · confirmed on-chain". Stop recording.

## What Claude records (shots 2, 3, 16, 17)

In the browser, at phone size, so it cuts cleanly with the iPhone footage: the landing page, the mainnet web app,
`/judge?owner=<your address>` (read straight off the chain, no sign-in), and the end card.

## The edit

`ffmpeg`, by Claude: the film → landing → web → your iPhone clip, shots 4–15 (sped up where the signatures run and
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
