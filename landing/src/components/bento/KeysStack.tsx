"use client";

import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { XorrMark } from "@/components/XorrMark";

/** Where each row of the stack rests: front, middle, back. */
const DEPTH = [
  { y: 0, scale: 1, opacity: 1 },
  { y: -22, scale: 0.93, opacity: 0.6 },
  { y: -42, scale: 0.86, opacity: 0.3 },
];

/**
 * The coin over a deck of activity rows. Every few seconds the front row falls away and the deck advances —
 * the rows are skeletons on purpose: there is no account on a landing page, so there is no activity to show.
 */
export function KeysStack() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduce = useReducedMotion();
  const [head, setHead] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => setHead((h) => h + 1), 2600);
    return () => clearInterval(id);
  }, [inView, reduce]);

  return (
    <div ref={ref} className="relative flex h-[200px] w-full max-w-[460px] justify-center">
      <AnimatePresence initial={false}>
        {DEPTH.map((rest, depth) => (
          <motion.div
            key={head + depth}
            className="absolute bottom-4 w-[88%] rounded-2xl border border-white/[0.08] bg-[linear-gradient(180deg,#16161b,#0d0d11)] p-3.5 shadow-[0_24px_40px_-24px_rgba(0,0,0,0.95)]"
            style={{ zIndex: DEPTH.length - depth }}
            initial={{ y: -64, scale: 0.8, opacity: 0 }}
            animate={rest}
            exit={{ y: 36, scale: 1.03, opacity: 0 }}
            transition={{ type: "spring", stiffness: 180, damping: 24 }}
          >
            <div className="flex items-center gap-3">
              <span className="size-9 shrink-0 rounded-full bg-white/[0.07]" />
              <span className="flex-1 space-y-2">
                <span className="block h-2 w-2/5 rounded-full bg-white/[0.14]" />
                <span className="block h-2 w-3/5 rounded-full bg-white/[0.07]" />
              </span>
              <span className="h-6 w-14 rounded-full bg-white/[0.07]" />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      <div className="absolute left-1/2 top-0 z-10 -translate-x-1/2">
        <div className="grid size-[92px] animate-float place-items-center rounded-full bg-[radial-gradient(circle_at_35%_28%,#3b3b44_0%,#16161b_48%,#050506_100%)] shadow-[0_28px_50px_-14px_rgba(0,0,0,0.95),inset_0_1px_1px_rgba(255,255,255,0.28),0_0_0_1px_rgba(255,255,255,0.08)] motion-reduce:animate-none">
          <XorrMark className="w-10 text-ink" />
        </div>
      </div>
    </div>
  );
}
