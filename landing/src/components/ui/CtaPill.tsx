import { Icon } from "@/components/ui/Icon";
import { APP_URL } from "@/lib/links";

/**
 * The reference's email field joined to its "Join waitlist" button, kept as a shape. xorr has no waitlist — the app
 * is open — so the left half states a fact instead of asking for an address, and the whole pill goes to the app.
 */
export function CtaPill({ className = "" }: { className?: string }) {
  return (
    <a
      href={APP_URL}
      className={`group inline-flex h-12 items-center rounded-full border border-white/10 bg-white/[0.04] p-1 pl-5 text-[14px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md transition-transform duration-150 ease-out active:scale-[0.98] ${className}`}
    >
      <span className="flex items-center gap-2 pr-5 text-ink/60">
        <span aria-hidden className="size-1.5 rounded-full bg-mint shadow-[0_0_10px_rgba(13,216,126,0.9)]" />
        Built on X Layer
      </span>
      <span className="flex h-full items-center gap-1.5 rounded-full bg-ink px-5 font-medium text-[#07080a] transition-colors duration-200 group-hover:bg-white">
        Open the app
        <Icon
          name="arrowUpRight"
          className="size-4 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
          strokeWidth={2}
        />
      </span>
    </a>
  );
}
