"use client";

import { motion, useReducedMotion, type Variants } from "motion/react";

const EASE = [0.16, 1, 0.3, 1] as const;

type BlurWordsProps = {
  text: string;
  className?: string;
  /** Seconds before the first word starts. */
  delay?: number;
  /** Seconds between consecutive words. */
  stagger?: number;
  /** Play on mount (the hero) instead of when scrolled into view. */
  immediate?: boolean;
};

/**
 * A heading that resolves word by word out of a blur — the reveal every headline in the reference uses.
 * Lines split on "\n", so where a headline breaks is authored rather than left to the viewport.
 */
export function BlurWords({ text, className = "", delay = 0, stagger = 0.07, immediate = false }: BlurWordsProps) {
  const reduce = useReducedMotion();
  const lines = text.split("\n").map((line) => line.split(" "));
  const starts = lines.map((_, i) => lines.slice(0, i).reduce((n, words) => n + words.length, 0));

  const word: Variants = {
    hidden: reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(12px)", y: "0.28em" },
    shown: (i: number) => ({
      opacity: 1,
      filter: "blur(0px)",
      y: "0em",
      transition: { duration: reduce ? 0.5 : 1.05, ease: EASE, delay: delay + i * stagger },
    }),
  };

  const play = immediate
    ? { animate: "shown" }
    : { whileInView: "shown", viewport: { once: true, amount: 0.5 } };

  return (
    <motion.span className={`block ${className}`} initial="hidden" {...play}>
      {lines.map((words, l) => (
        <span key={l} className="block">
          {words.map((w, k) => (
            <span key={k}>
              <motion.span custom={starts[l] + k} variants={word} className="inline-block will-change-transform">
                {w}
              </motion.span>
              {k < words.length - 1 ? " " : null}
            </span>
          ))}
        </span>
      ))}
    </motion.span>
  );
}
