/**
 * The current time, as something a component may read during render.
 *
 * `Date.now()` in a render body is impure — two renders of the same props give different output,
 * which is exactly what React Compiler's purity rule exists to catch. It is also a real bug and not
 * only a lint one: a value derived from the wall clock mid-render is a value React may discard,
 * recompute, or render at a different time than you think.
 *
 * The fix is a clock that is state. This ticks on an interval and returns the timestamp, so the
 * comparison in the render body reads a value React knows about.
 *
 * Pick the interval from what is being measured. A proposal counting down to expiry needs a second;
 * a permission expiring in nine days does not, and a one-second interval behind a screen nobody is
 * watching is a wakeup every second for a number that changes daily.
 */
import { useEffect, useState } from 'react';

export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);

  return now;
}
