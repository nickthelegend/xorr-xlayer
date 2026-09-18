"use client";

import Image from "next/image";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useRef, type ReactNode } from "react";
import { BlurWords } from "@/components/motion/BlurWords";
import { LoopVideo } from "@/components/motion/LoopVideo";
import { Reveal } from "@/components/motion/Reveal";
import { CtaPill } from "@/components/ui/CtaPill";
import { Icon } from "@/components/ui/Icon";
import { XorrMark } from "@/components/XorrMark";

const EASE = [0.16, 1, 0.3, 1] as const;

/** Specks of light over the art, as the reference scatters them around its coins. */
const SPECKS = [
  { left: "12%", top: "20%", size: 3, delay: "0s" },
  { left: "23%", top: "58%", size: 2, delay: "1.2s" },
  { left: "38%", top: "12%", size: 2, delay: "2.1s" },
  { left: "61%", top: "16%", size: 3, delay: "0.6s" },
  { left: "74%", top: "54%", size: 2, delay: "1.8s" },
  { left: "86%", top: "26%", size: 3, delay: "2.7s" },
  { left: "93%", top: "62%", size: 2, delay: "0.9s" },
];

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const artY = useTransform(scrollYProgress, [0, 1], ["0%", reduce ? "0%" : "20%"]);
  const artScale = useTransform(scrollYProgress, [0, 1], [1, reduce ? 1 : 1.12]);
  const copyY = useTransform(scrollYProgress, [0, 1], ["0%", reduce ? "0%" : "-35%"]);
  const copyOpacity = useTransform(scrollYProgress, [0, 0.55], [1, 0]);

  return (
    <section ref={ref} className="relative isolate flex min-h-[max(760px,100svh)] flex-col items-center overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(85%_60%_at_50%_-8%,rgba(47,91,255,0.5)_0%,rgba(28,52,180,0.2)_42%,transparent_72%),radial-gradient(40%_36%_at_90%_10%,rgba(183,166,255,0.13),transparent_70%)]"
      />

      <motion.div aria-hidden style={{ y: artY, scale: artScale }} className="absolute inset-x-0 top-0 h-[74%]">
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.08, filter: "blur(28px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          transition={{ duration: 1.8, ease: EASE }}
          className="relative h-full w-full [mask-image:radial-gradient(78%_72%_at_50%_42%,#000_48%,transparent_100%)]"
        >
          <div className="absolute inset-0 animate-float-slow motion-reduce:animate-none">
            {/* The ChatGPT still, animated by Gemini. Its poster is the film's own first frame, so nothing jumps when it starts. */}
            <LoopVideo
              preload="auto"
              poster="/media/hero-poster.webp"
              className="h-full w-full object-cover object-[32%_50%] md:object-[50%_45%]"
              sources={[
                { src: "/media/hero.webm", type: "video/webm" },
                { src: "/media/hero.mp4", type: "video/mp4" },
              ]}
            />
          </div>
        </motion.div>
      </motion.div>

      <div aria-hidden className="noise absolute inset-0" />

      {SPECKS.map((s) => (
        <span
          key={s.left}
          aria-hidden
          className="absolute animate-twinkle rounded-full bg-ink motion-reduce:animate-none"
          style={{ left: s.left, top: s.top, width: s.size, height: s.size, animationDelay: s.delay }}
        />
      ))}

      <motion.header
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, ease: EASE, delay: 0.15 }}
        className="relative z-10 pt-7"
      >
        <Image src="/brand/xorr-wordmark.png" alt="xorr" width={841} height={182} loading="eager" className="h-[14px] w-auto" />
      </motion.header>

      <Chip className="left-[7%] top-[60%]" delay={1.5}>
        <Icon name="wave" className="size-4" />
      </Chip>
      <Chip className="right-[8%] top-[46%]" delay={1.7}>
        <XorrMark dot={false} className="w-4" />
      </Chip>

      <motion.div
        style={{ y: copyY, opacity: copyOpacity }}
        className="relative z-10 mt-auto flex w-full flex-col items-center px-6 pb-[max(56px,9vh)] text-center"
      >
        <h1 className="text-balance font-display text-[clamp(2.6rem,6vw,5.4rem)] font-medium leading-[1.02] tracking-[-0.045em] text-ink">
          <BlurWords immediate delay={0.55} text={"A bot that trades while you\nget on with your life"} />
        </h1>
        <Reveal immediate delay={1.3} className="mt-9">
          <CtaPill />
        </Reveal>
      </motion.div>
    </section>
  );
}

/** A small glass disc floating beside the art, like the reference's contactless and logo badges. */
function Chip({ className, delay, children }: { className: string; delay: number; children: ReactNode }) {
  return (
    <motion.span
      aria-hidden
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay, duration: 0.9, ease: EASE }}
      className={`absolute z-10 hidden md:block ${className}`}
    >
      <span className="grid size-11 animate-float place-items-center rounded-full border border-white/10 bg-white/[0.06] text-ink/80 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-md motion-reduce:animate-none">
        {children}
      </span>
    </motion.span>
  );
}
