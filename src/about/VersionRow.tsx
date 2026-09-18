/**
 * Which code this is, and whether the executor it reads runs the same (FEATURES.md #53).
 *
 * The web app deploys to Vercel and each executor to Railway, separately, so "fixed on main" can be true of one and not
 * the other — and a screen one commit ahead of its server looks exactly like a bug in either. The bundle names its own
 * commit (`src/version.ts`); an executor names its commit on `/health`. One quiet row: the commit when they agree, both
 * of them in the warning colour when they do not.
 */
import React from 'react';
import { Row, Text, colors } from '@/ui';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';
import { appCommit, compareVersions, serverMatch, shortCommit } from '@/version';

export function VersionRow({ height }: { height: number }) {
  const health = useAsync(() => system.health(), []);
  // An executor still on the commit a web-only deploy left it at runs this build's server code: that agrees.
  const versions = compareVersions(appCommit, health.data?.version, serverMatch);
  const label =
    versions.kind === 'same'
      ? shortCommit(versions.commit)
      : versions.kind === 'different'
        ? `App ${shortCommit(versions.app)} · server ${shortCommit(versions.executor)}`
        : appCommit
          ? shortCommit(appCommit)
          : // Metro serves whatever is on disk, which is no commit at all.
            'Development build';

  return (
    <Row
      title="Version"
      value={
        <Text variant="rowPrimary" color={versions.kind === 'different' ? colors.warn : colors.ink55} selectable>
          {label}
        </Text>
      }
      height={height}
      divider={false}
    />
  );
}
