"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

type LoopVideoProps = {
  sources: { src: string; type: string }[];
  poster: string;
  className?: string;
  preload?: "auto" | "metadata" | "none";
};

/**
 * A muted, looping film. It plays only while it is on screen, and holds on its poster for anyone who asked for
 * reduced motion.
 */
export function LoopVideo({ sources, poster, className, preload = "metadata" }: LoopVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (reduce) {
      video.pause();
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        // A browser that refuses autoplay leaves the poster up, which is the right thing to show.
        if (entry.isIntersecting) void video.play().catch(() => undefined);
        else video.pause();
      },
      { threshold: 0.05 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [reduce]);

  return (
    <video ref={ref} className={className} muted loop playsInline preload={preload} poster={poster} aria-hidden>
      {sources.map((s) => (
        <source key={s.src} src={s.src} type={s.type} />
      ))}
    </video>
  );
}
