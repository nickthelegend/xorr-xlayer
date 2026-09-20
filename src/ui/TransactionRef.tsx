/**
 * A transaction, as a screen shows it: a link where one exists, the hash alone where none does.
 *
 * `explorerTx` (server) answers a real URL on a public chain and a `fork:` or `local:` label on a chain no explorer
 * has seen. A link to an explorer that has never heard of the transaction reads as the transaction not being real, so
 * the label is never dressed up as one — and the label itself is not shown either: "fork:0x64c4…" is the server's
 * word for "nowhere to link to", not something a person needs. Activity and History each had their own copy of this;
 * "Sell everything" had none and printed the raw label under a filled sale (seen 2026-09-20).
 *
 * The audit screen is the one place that deliberately prints the stored value verbatim, because showing what was
 * recorded is its whole job.
 */
import React from 'react';
import { Linking } from 'react-native';
import { Press } from './Press';
import { Text } from './Text';
import { colors } from './tokens';

/** What to show for a reference: the URL to open, or the short hash to print. */
export function transactionRef(explorer: string): { href: string } | { hash: string } {
  if (explorer.startsWith('http')) return { href: explorer };
  // The hash alone: which network it is on is not named off the money screens (PLAN.md O3).
  const ref = explorer.includes(':') ? explorer.slice(explorer.indexOf(':') + 1) : explorer;
  return { hash: ref ? `${ref.slice(0, 10)}…` : '' };
}

export function TransactionRef({ explorer }: { explorer: string }) {
  const shown = transactionRef(explorer);
  if ('hash' in shown) {
    return (
      <Text variant="footnote" color={colors.ink55}>
        {shown.hash}
      </Text>
    );
  }
  return (
    <Press
      onPress={() => void Linking.openURL(shown.href)}
      accessibilityRole="link"
      accessibilityLabel="View this transaction"
      hitHeight={24}
    >
      <Text variant="footnote" color={colors.ink55}>
        View transaction ›
      </Text>
    </Press>
  );
}
