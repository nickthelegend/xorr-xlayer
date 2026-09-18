"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The second sheet slides up over the first, which holds still and falls back into the dark.
 *
 * The first sheet is taller than the screen, so it cannot pin at `top: 0` — it pins at the offset that keeps its
 * bottom edge on the bottom of the viewport, and that offset has to be measured.
 */
export function StackedSheets({ first, second }: { first: ReactNode; second: ReactNode }) {
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = firstRef.current;
    if (!el) return;
    const measure = () => setTop(Math.min(0, window.innerHeight - el.offsetHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const { scrollYProgress } = useScroll({ target: secondRef, offset: ["start end", "start start"] });
  const scale = useTransform(scrollYProgress, [0, 1], [1, reduce ? 1 : 0.9]);
  const dim = useTransform(scrollYProgress, [0, 1], [0, 0.72]);

  return (
    <div className="relative">
      <motion.div ref={firstRef} className="sticky origin-bottom" style={{ top, scale }}>
        {first}
        <motion.div aria-hidden className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: dim }} />
      </motion.div>
      <div ref={secondRef} className="relative z-10">
        {second}
      </div>
    </div>
  );
}
