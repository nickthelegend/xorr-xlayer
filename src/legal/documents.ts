/**
 * Legal copy — PLAN.md 14.3 [G38].
 *
 * Drafted in the app's own voice (copy.md: plain, specific, name the consequence). These are a
 * genuine first draft, not placeholders — but PLAN.md 14.2 still stands: the non-custodial posture
 * is jurisdiction-specific and needs counsel before launch. That caveat is stated in-app.
 *
 * Every sentence here is a claim about what the contract and the executor do, checked against them
 * on 2026-09-14. The risk disclosure explained leverage liquidation for an app that trades no
 * leverage. A revoke was said to stop new orders only, when `closePosition` checks the same revoked
 * flag and expiry as `spend` (contracts/src/XorrDelegation.sol) — so stop-losses stop too. The privacy
 * policy said keys "never leave your device" of a wallet whose key the app never holds at all, left
 * out what the executor does store, and described crash reports the app does not send.
 */
export type LegalDoc = {
  title: string;
  updated: string;
  sections: { heading: string; paragraphs: string[] }[];
  footer: string;
};

const REVIEW_NOTE =
  'This is xorr’s own draft. It has not yet been reviewed by counsel in every market where the app is available.';

export const LEGAL: Record<string, LegalDoc> = {
  terms: {
    title: 'Terms',
    updated: 'Draft — September 2026',
    sections: [
      {
        heading: 'What xorr is',
        paragraphs: [
          'xorr is software that runs trading strategies on your behalf. It is not a broker, an exchange, or a custodian.',
          'Your funds stay in a wallet you control. xorr never holds them and cannot move them to an address you have not allowlisted.',
        ],
      },
      {
        heading: 'What you are agreeing to',
        paragraphs: [
          'When you grant the bot permission to trade, you are authorising software to place orders with your capital, inside the limits you set, without asking you first.',
          'You can revoke that permission at any time. Revocation takes effect on-chain, not on our servers, so it does not depend on xorr being reachable.',
          'Revoking stops every trade the bot could make, stop-losses included. It does not unwind positions already open, and a trade already sent may still settle.',
        ],
      },
      {
        heading: 'What we do not promise',
        paragraphs: [
          'We do not promise returns. Past performance of a strategy says nothing about tomorrow.',
          'We do not promise that a strategy will execute. Networks congest, venues halt, and transactions fail. When that happens it is recorded in your activity.',
          'We do not give investment advice. The bot describes what it did and why; that is a record, not a recommendation.',
        ],
      },
      {
        heading: 'Your responsibilities',
        paragraphs: [
          'Keep access to how you sign in. It is the way back to your wallet, and we cannot restore it for you.',
          'Set limits you can afford to lose. The daily cap limits how much the bot can spend in a day. It does not limit how much a position can lose.',
        ],
      },
    ],
    footer: REVIEW_NOTE,
  },
  privacy: {
    title: 'Privacy',
    updated: 'Draft — September 2026',
    sections: [
      {
        heading: 'What we store',
        paragraphs: [
          'Your wallet address and the account it belongs to, the permission you granted, the strategies, agents and alerts you set, the addresses you allowlist, your positions, trades and balance history, and the audit trail of what the bot did.',
          'If you turn on notifications, a push token for your device.',
          'We never hold or see your private key. Your email is held by Privy, which signs you in, and we do not store it.',
        ],
      },
      {
        heading: 'What we send elsewhere',
        paragraphs: [
          'Market data requests go to public price APIs and carry no information about you.',
          'Trades settle on X Layer through public contracts (Uniswap v3), which needs no third-party service. When OKX DEX is enabled, a route request goes to OKX with your wallet address, because that is where the tokens are delivered.',
          'When the bot writes a message, the market context and anything you ask it are sent to a language model. Your wallet address and balances are not.',
        ],
      },
      {
        heading: 'Crash reports and analytics',
        paragraphs: ['xorr sends no crash reports and runs no analytics.'],
      },
    ],
    footer: REVIEW_NOTE,
  },
  risk: {
    title: 'Risk disclosure',
    updated: 'Draft — September 2026',
    sections: [
      {
        heading: 'You can lose money',
        paragraphs: [
          'Every strategy in this app can lose money, including the ones that look safest. A recurring buy keeps buying while a price falls.',
        ],
      },
      {
        heading: 'Spot trades carry the whole move',
        paragraphs: [
          'The bot buys and sells tokens outright, with no leverage. A token can lose most or all of its value, and a sale fills at the price a route gives at that moment, which can be worse than the price you last saw.',
        ],
      },
      {
        heading: 'Tokenized stocks are tokens',
        paragraphs: [
          'A tokenized stock is a token issued by a third party to track a company’s shares. Its price here is what a real buy of the token would cost, which can differ from the stock market’s price, and on some networks it cannot be traded at all.',
        ],
      },
      {
        heading: 'The daily cap limits spending, not losses',
        paragraphs: [
          'The cap bounds how much the bot can spend in a day. Selling does not count against it, and it does not limit how far a position you hold can fall.',
        ],
      },
      {
        heading: 'A permission acts without you',
        paragraphs: [
          'While your permission is live, the bot trades inside your limits without asking, including while you are asleep. Software has bugs, and a strategy can behave in a way neither you nor we intended.',
          'Stopping your agents revokes the permission on-chain, and from then on nothing trades for you, stop-losses included. Open positions stay open until you trade them from your own wallet or grant a new permission. The same holds once a permission reaches its end date.',
        ],
      },
      {
        heading: 'On-chain transactions are final',
        paragraphs: [
          'A confirmed transaction cannot be reversed, by us or by anyone. There is no chargeback.',
        ],
      },
    ],
    footer: REVIEW_NOTE,
  },
};
