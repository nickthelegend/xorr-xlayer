/**
 * A connection string with its password taken out, for a log line.
 *
 * `migrate.ts` printed `DATABASE_URL` whole, so every deploy wrote the database password into the host's deploy logs,
 * while the runtime banner in `index.ts` masked it with a pattern of its own. One function now serves both lines.
 *
 * Parsed as a URL, so a password holding `:` or `@` is removed whole rather than cut at its first such character. A
 * string that does not parse loses everything between its first `//user:` and the last `@` after it.
 */
export function withoutPassword(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/(\/\/[^:/@]*:)[^/]*@/, '$1***@');
  }
}
