import { describe, expect, it } from 'vitest';
import { compareVersions, shortCommit } from './version';

const FULL = '8c05266580eea505cd7bcac3a8e5c66a0742d2a3';

describe('compareVersions', () => {
  it('agrees when both name the same commit, even when one is short', () => {
    expect(compareVersions(FULL, FULL)).toEqual({ kind: 'same', commit: FULL });
    expect(compareVersions('8c05266', FULL)).toEqual({ kind: 'same', commit: FULL });
    expect(compareVersions(FULL.toUpperCase(), FULL)).toEqual({ kind: 'same', commit: FULL });
  });

  it('says so when the app and the executor were built from different commits', () => {
    expect(compareVersions(FULL, 'e607289ab')).toEqual({ kind: 'different', app: FULL, executor: 'e607289ab' });
  });

  it('agrees when the executor is on an older commit that runs this build’s server code', () => {
    // A web-only deploy: the build found nothing under server/ changed since the executor's commit.
    expect(compareVersions(FULL, 'e607289ab', 'e607289ab4c1')).toEqual({ kind: 'same', commit: FULL });
  });

  it('does not let a match for some other commit hide a difference', () => {
    expect(compareVersions(FULL, 'e607289ab', '1234567')).toEqual({ kind: 'different', app: FULL, executor: 'e607289ab' });
    expect(compareVersions(FULL, 'e607289ab', 'not-a-commit')).toEqual({ kind: 'different', app: FULL, executor: 'e607289ab' });
  });

  it('is unknown, not a guess, when either side did not say or said something that is not a commit', () => {
    expect(compareVersions(undefined, FULL).kind).toBe('unknown');
    expect(compareVersions(FULL, undefined).kind).toBe('unknown');
    expect(compareVersions(FULL, 'dev').kind).toBe('unknown');
  });
});

describe('shortCommit', () => {
  it('is seven characters, as git prints one', () => {
    expect(shortCommit(FULL)).toBe('8c05266');
  });
});
