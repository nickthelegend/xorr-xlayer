"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

const EASE = [0.16, 1, 0.3, 1] as const;

type RevealProps = {
  children?: ReactNode;
  className?: string;
  delay?: number;
  /** How far the block travels upward, in px. */
  y?: number;
  /** Play on mount instead of when scrolled into view. */
  immediate?: boolean;
};

/** Blocks arrive the way the headings do: upward, out of a light blur. */
export function Reveal({ children, className, delay = 0, y = 26, immediate = false }: RevealProps) {
  const reduce = useReducedMotion();
  const shown = { opacity: 1, y: 0, filter: "blur(0px)" };
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y, filter: "blur(8px)" }}
      {...(immediate ? { animate: shown } : { whileInView: shown, viewport: { once: true, amount: 0.25 } })}
      transition={{ duration: 1, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}
