"use client";

import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

/** The four personas the executor runs (src/chat/agents.ts in the app), each drawn as an orb. */
const AGENTS: { name: string; icon: IconName; face: string; ink: string }[] = [
  {
    name: "Momentum Scout",
    icon: "trendingUp",
    face: "bg-[radial-gradient(circle_at_34%_26%,#9db3ff_0%,#2f5bff_48%,#1a2a8f_100%)]",
    ink: "text-white",
  },
  {
    name: "Yield Keeper",
    icon: "percent",
    face: "bg-[radial-gradient(circle_at_34%_26%,#f1ecff_0%,#b7a6ff_48%,#7358dd_100%)]",
    ink: "text-[#261b55]",
  },
  {
    name: "Drawdown Guard",
    icon: "shield",
    face: "bg-[radial-gradient(circle_at_34%_26%,#4a4a54_0%,#17171c_50%,#050506_100%)]",
    ink: "text-lime",
  },
  {
    name: "Earnings Desk",
    icon: "calendar",
    face: "bg-[radial-gradient(circle_at_34%_26%,#f3ffd0_0%,#c8f53c_48%,#78a50f_100%)]",
    ink: "text-[#141b07]",
  },
];

/** Three orbs in a tray; the first drops out and the next agent slides in at the end, on a loop. */
export function AgentShuffle() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.5 });
  const reduce = useReducedMotion();
  const [first, setFirst] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setFirst((f) => (f + 1) % AGENTS.length), 2000);
    return () => clearInterval(id);
  }, [inView, reduce]);

  const shown = [0, 1, 2].map((p) => AGENTS[(first + p) % AGENTS.length]);

  return (
    <div
      ref={ref}
      className="relative flex h-[132px] items-center rounded-full border border-white/[0.07] bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] px-7 shadow-[0_40px_80px_-40px_rgba(47,91,255,0.45),inset_0_1px_0_rgba(255,255,255,0.06)]"
    >
      <ul className="flex items-center" aria-label="The four agents">
        <AnimatePresence mode="popLayout" initial={false}>
          {shown.map((agent, pos) => (
            <motion.li
              key={agent.name}
              layout
              className="-ml-6 first:ml-0"
              style={{ zIndex: pos === 1 ? 3 : 2 - pos / 2 }}
              initial={{ opacity: 0, scale: 0.5, filter: "blur(6px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0.5, filter: "blur(6px)" }}
              transition={{ type: "spring", stiffness: 240, damping: 26 }}
            >
              <span
                title={agent.name}
                className={`grid size-[88px] place-items-center rounded-full shadow-[0_22px_34px_-14px_rgba(0,0,0,0.9),inset_0_1px_1px_rgba(255,255,255,0.35)] ring-1 ring-white/10 ${agent.face}`}
              >
                <Icon name={agent.icon} className={`size-8 ${agent.ink}`} />
                <span className="sr-only">{agent.name}</span>
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
