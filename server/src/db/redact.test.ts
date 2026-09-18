/**
 * The database password never reaches a log line: `migrate.ts` printed `DATABASE_URL` whole on every deploy.
 */
import { describe, expect, it } from 'vitest';
import { withoutPassword } from './redact.js';

describe('withoutPassword', () => {
  it('takes the password out of a Postgres URL and keeps the rest', () => {
    expect(withoutPassword('postgresql://postgres:s3cret@postgres-a.railway.internal:5432/railway')).toBe(
      'postgresql://postgres:***@postgres-a.railway.internal:5432/railway',
    );
  });

  it('removes a password holding : and @ whole, not up to its first such character', () => {
    const out = withoutPassword('postgresql://postgres:pa:ss@wo@rd@host:5432/db');
    expect(out).toBe('postgresql://postgres:***@host:5432/db');
  });

  it('masks a MongoDB SRV string the same way', () => {
    const out = withoutPassword('mongodb+srv://reader:hunter2@cluster0.example.net/xorr?retryWrites=true');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('reader:***@cluster0.example.net');
  });

  it('leaves a URL with no password, and a name that is not a URL, as they were', () => {
    expect(withoutPassword('postgresql://localhost:5432/xorr')).toBe('postgresql://localhost:5432/xorr');
    expect(withoutPassword('default local xorr')).toBe('default local xorr');
  });
});
