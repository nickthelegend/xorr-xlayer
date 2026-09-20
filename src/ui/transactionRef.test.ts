/**
 * What a screen shows for a transaction.
 *
 * `explorerTx` answers a real URL on a public chain and a `fork:` or `local:` label where no explorer has seen it.
 * "Sell everything" printed that label raw under a filled sale — "fork:0x64c409aa…", the server's way of saying there
 * is nowhere to link to, shown to a person as though it were the receipt.
 */
import { describe, expect, it } from 'vitest';
import { transactionRef } from './TransactionRef';

describe('transactionRef', () => {
  it('links where an explorer has the transaction', () => {
    const url = 'https://www.oklink.com/xlayer-test/tx/0xabc';
    expect(transactionRef(url)).toEqual({ href: url });
  });

  it('shows the hash alone where nothing can be linked to, never the scheme', () => {
    expect(transactionRef('fork:0x64c409aa774aa531b3b64cbc155b085b')).toEqual({ hash: '0x64c409aa…' });
    expect(transactionRef('local:0x1234567890abcdef')).toEqual({ hash: '0x12345678…' });
  });

  it('copes with a bare hash and with nothing at all', () => {
    expect(transactionRef('0x1234567890abcdef')).toEqual({ hash: '0x12345678…' });
    expect(transactionRef('fork:')).toEqual({ hash: '' });
  });
});
