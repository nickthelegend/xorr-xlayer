/**
 * A funding rate is paid per interval, and the interval is the venue's.
 *
 * The contract screen labelled every rate "Funding / hour" and counted down to the next top of the hour
 * by the phone's own clock; the list annualised every rate as hourly. The venue sends its interval and
 * its own next payment time, so the words and the clock come from those.
 */
const HOUR_MS = 3_600_000;

/** The next payment, from the venue's own time — rolled on by its interval once that time has passed. */
export function nextPaymentAt(at: number, intervalHours: number, now: number): number {
  const interval = intervalHours * HOUR_MS;
  if (at > now || !(interval > 0)) return at;
  return at + (Math.floor((now - at) / interval) + 1) * interval;
}

/** How an interval reads: "hour" / "8h" after a slash, "h" / "8h" beside a rate, "every hour" in a sentence. */
export function intervalWords(hours: number): { unit: string; short: string; every: string } {
  return hours === 1
    ? { unit: 'hour', short: 'h', every: 'every hour' }
    : { unit: `${hours}h`, short: `${hours}h`, every: `every ${hours} hours` };
}

/** How many payments make a year, for a rate stated per interval. */
export function paymentsPerYear(hours: number): number {
  return (24 * 365) / hours;
}
