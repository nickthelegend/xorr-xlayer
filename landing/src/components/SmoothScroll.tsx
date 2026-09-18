"use client";

import { ReactLenis } from "lenis/react";
import { useReducedMotion } from "motion/react";

/** Inertial scrolling for the page. Anyone who asked for less motion keeps the browser's own scroll. */
export function SmoothScroll() {
  const reduce = useReducedMotion();
  if (reduce) return null;
  return <ReactLenis root options={{ lerp: 0.11, wheelMultiplier: 0.95 }} />;
}
