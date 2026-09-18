import type { ReactNode } from "react";
import { Reveal } from "@/components/motion/Reveal";

/** A bento tile: near-black, a hairline edge, and a faint top highlight so it reads as a surface. */
export function Card({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <Reveal
      delay={delay}
      className={`relative overflow-hidden rounded-[28px] border border-white/[0.065] bg-[linear-gradient(180deg,#0d0d11_0%,#08080a_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ${className}`}
    >
      {children}
    </Reveal>
  );
}

/** The large faint circle the reference lets bleed off a card's edge. */
export function Arc({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`pointer-events-none absolute size-80 rounded-full border border-white/[0.05] ${className}`} />;
}
