/**
 * Whether the Messages drawer is up, and which conversation it shows.
 *
 * One drawer, mounted once at the root (`app/_layout.tsx`), opened from wherever the agents are asked for: the tab bar's
 * Messages button, and the `/bot` route that pushes and the briefing link to. It opens on the list of conversations, or
 * straight into one agent's. State rather than a route, because the drawer rises over the screen you are on instead of
 * replacing it.
 */
import { create } from 'zustand';

/**
 * How long the drawer waits for you to come back from a screen it opened.
 *
 * Long enough to read a profile or an earnings calendar; short enough that the drawer does not rise, unasked, over a
 * screen visited again much later.
 */
export const RETURN_WITHIN_MS = 10 * 60_000;

type ChatDrawerState = {
  open: boolean;
  /**
   * The drawer is rising or up: set by the drawer itself once it has laid out and starts to rise, and cleared the moment
   * it starts down. The tab bar goes down on this rather than on `open`, so the two move together.
   */
  raised: boolean;
  /** The agent whose conversation is showing, or null for the list. */
  agent: string | null;
  /** The screen the drawer went down from to open another, or null. */
  leftFrom: string | null;
  /** When it went down for that screen. */
  leftAt: number | null;
  /** Raise the drawer, on the list or on one agent's conversation. */
  show: (agent?: string | null) => void;
  hide: () => void;
  setRaised: (raised: boolean) => void;
  openConversation: (agent: string) => void;
  showList: () => void;
  /**
   * Lower the drawer to open a screen from inside it (your profile, an agent's page), remembering where it was.
   *
   * A pushed screen cannot sit above the drawer, which is mounted over the whole navigator, so the drawer goes down. When
   * the screen it went down from is in view again, `returned` brings it back up on the same list or conversation, as a
   * messenger's chat is still there when you come back from a profile.
   */
  leave: (from: string, now?: number) => void;
  /** The screen in view changed: raise the drawer if this is the one it left from, recently enough. */
  returned: (pathname: string, now?: number) => void;
};

export const useChatDrawer = create<ChatDrawerState>((set) => ({
  open: false,
  raised: false,
  agent: null,
  leftFrom: null,
  leftAt: null,
  show: (agent = null) => set({ open: true, agent, leftFrom: null, leftAt: null }),
  hide: () => set({ open: false, leftFrom: null, leftAt: null }),
  setRaised: (raised) => set({ raised }),
  openConversation: (agent) => set({ agent }),
  showList: () => set({ agent: null }),
  leave: (from, now = Date.now()) => set({ open: false, leftFrom: from, leftAt: now }),
  returned: (pathname, now = Date.now()) =>
    set((s) => {
      // Still on the screen it opened, or never left: nothing to do, and the same state back changes nothing.
      if (s.leftFrom === null || s.leftFrom !== pathname) return s;
      const recent = s.leftAt !== null && now - s.leftAt <= RETURN_WITHIN_MS;
      return { open: recent, leftFrom: null, leftAt: null };
    }),
}));
