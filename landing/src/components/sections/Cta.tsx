"use client";

import Image from "next/image";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";
import { BlurWords } from "@/components/motion/BlurWords";
import { Reveal } from "@/components/motion/Reveal";
import { CtaPill } from "@/components/ui/CtaPill";
import { Icon } from "@/components/ui/Icon";
import { XorrMark } from "@/components/XorrMark";
import { APP_URL, GITHUB_URL } from "@/lib/links";

const SPHERES = [
  { className: "left-[15%] top-[62%] size-4", tone: "bg-[radial-gradient(circle_at_35%_30%,#b9c8ff,#2f5bff_60%,#172a8a)]", delay: "0s" },
  { className: "right-[19%] top-[30%] size-3", tone: "bg-[radial-gradient(circle_at_35%_30%,#f1ffc9,#c8f53c_60%,#6f9c0e)]", delay: "1.4s" },
  { className: "left-[27%] top-[24%] size-2", tone: "bg-[radial-gradient(circle_at_35%_30%,#efe9ff,#b7a6ff_60%,#6d52d8)]", delay: "2.2s" },
];

/** The closing ask: the app tile, one line, the pill — and coins drifting in from the edges as it scrolls up. */
export function Cta() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end end"] });
  const leftY = useTransform(scrollYProgress, [0, 1], [reduce ? 0 : 180, 0]);
  const leftRotate = useTransform(scrollYProgress, [0, 1], [reduce ? 0 : -24, 0]);
  const rightY = useTransform(scrollYProgress, [0, 1], [reduce ? 0 : 260, 0]);
  const rightRotate = useTransform(scrollYProgress, [0, 1], [reduce ? 0 : 30, 0]);

  return (
    <section ref={ref} className="relative overflow-hidden px-4 pb-8 pt-36 sm:px-8 md:pt-44">
      <motion.div
        aria-hidden
        style={{ y: leftY, rotate: leftRotate }}
        // `lighten` drops the art's near-black ground into the sheet, so no rectangle shows around the coin.
        className="pointer-events-none absolute -left-[6%] top-[20%] w-[min(30vw,360px)] mix-blend-lighten"
      >
        <div className="animate-float-slow motion-reduce:animate-none">
          <Image
            src="/media/coin-sol.webp"
            alt=""
            width={720}
            height={720}
            sizes="30vw"
            className="h-auto w-full [mask-image:radial-gradient(closest-side,#000_70%,transparent)]"
          />
        </div>
      </motion.div>
      <motion.div
        aria-hidden
        style={{ y: rightY, rotate: rightRotate }}
        className="pointer-events-none absolute -right-[4%] bottom-[18%] w-[min(22vw,260px)] mix-blend-lighten"
      >
        <div className="animate-float motion-reduce:animate-none">
          <Image
            src="/media/coin-nvda.webp"
            alt=""
            width={520}
            height={520}
            sizes="22vw"
            className="h-auto w-full [mask-image:radial-gradient(closest-side,#000_70%,transparent)]"
          />
        </div>
      </motion.div>
      {SPHERES.map((s) => (
        <span
          key={s.className}
          aria-hidden
          className={`absolute animate-float rounded-full shadow-[0_6px_14px_rgba(0,0,0,0.6)] motion-reduce:animate-none ${s.className} ${s.tone}`}
          style={{ animationDelay: s.delay }}
        />
      ))}

      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center text-center">
        <Reveal>
          <div className="grid size-[76px] place-items-center rounded-[22px] bg-[linear-gradient(150deg,#e6ff94_0%,#c8f53c_42%,#0dd87e_100%)] shadow-[0_24px_60px_-12px_rgba(13,216,126,0.5),inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-4px_12px_rgba(0,60,30,0.25)]">
            <XorrMark dot={false} className="w-10 text-[#06110b]" title="xorr" />
          </div>
        </Reveal>
        <h2 className="mt-8 text-balance font-display text-[clamp(2.25rem,4.8vw,4rem)] font-medium leading-[1.04] tracking-[-0.04em]">
          <BlurWords text="Let the bot do the watching" />
        </h2>
        <Reveal delay={0.35}>
          <p className="mt-4 text-[15px] text-ink/60">Your wallet, your keys, and a bot that trades inside the limits you set.</p>
        </Reveal>
        <Reveal delay={0.5} className="mt-9">
          <CtaPill />
        </Reveal>
      </div>

      <footer className="relative z-10 mx-auto mt-36 flex max-w-6xl flex-col items-center gap-5 border-t border-white/[0.08] pt-7 text-[13px] text-ink/45 md:flex-row md:justify-between">
        <span>© 2026 xorr. All rights reserved.</span>
        <a
          href={GITHUB_URL}
          aria-label="xorr on GitHub"
          className="grid size-9 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-ink/70 transition-colors duration-200 hover:text-ink"
        >
          <Icon name="github" className="size-4" />
        </a>
        <a href={APP_URL} className="transition-colors duration-200 hover:text-ink">
          xorr-xlayer.vercel.app
        </a>
      </footer>
    </section>
  );
}
