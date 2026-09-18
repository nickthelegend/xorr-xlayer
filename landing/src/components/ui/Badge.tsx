import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

/** The small pill that sits above each section heading, with its lime disc. */
export function Badge({ children, icon = "arrowUpRight" }: { children: ReactNode; icon?: IconName }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] py-1 pl-3.5 pr-1 text-[12.5px] text-ink/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md">
      {children}
      <span aria-hidden className="grid size-5 place-items-center rounded-full bg-lime text-[#0c1003]">
        <Icon name={icon} className="size-3" strokeWidth={2.4} />
      </span>
    </span>
  );
}
