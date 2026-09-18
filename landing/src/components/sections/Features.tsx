"use client";

import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Reveal } from "@/components/motion/Reveal";
import { Icon, type IconName } from "@/components/ui/Icon";

const EASE = [0.16, 1, 0.3, 1] as const;
const DWELL_MS = 5600;

type Feature = {
  title: string;
  icon: IconName;
  points: [lead: string, rest: string][];
  Art: ComponentType;
};

const FEATURES: Feature[] = [
  {
    title: "The permission",
    icon: "shieldCheck",
    points: [
      ["Daily cap", "the bot cannot spend past the limit you set for the day."],
      ["Venue allowlist", "trades route only through the venues you approved."],
      ["Expiry", "the permission ends on its own, on the date you chose."],
    ],
    Art: RingsArt,
  },
  {
    title: "Autopilot",
    icon: "repeat",
    points: [
      ["Recurring buys", "placed on the schedule you pick."],
      ["Stops that hold", "exits written as rules, not reminders."],
    ],
    Art: AutopilotArt,
  },
  {
    title: "The trail",
    icon: "receipt",
    points: [
      ["Hash-chained", "every action the bot takes, and every one it declines, commits to the row before it."],
      ["Anchored on X Layer", "the head of that chain is published on an hourly sweep."],
    ],
    Art: TrailArt,
  },
];

/** Three capabilities on a timer: the list on the left follows the scene on the right, and either can be clicked. */
export function Features() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const id = setTimeout(() => setActive((a) => (a + 1) % FEATURES.length), DWELL_MS);
    return () => clearTimeout(id);
  }, [active, inView]);

  const { Art } = FEATURES[active];

  return (
    <section className="px-3 pt-24 sm:px-8 md:pt-28">
      <Reveal className="mx-auto max-w-6xl">
        <div
          ref={ref}
          className="grid gap-3 rounded-[32px] border border-white/10 bg-white/[0.035] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] md:grid-cols-[1fr_1.08fr] md:p-3"
        >
          <ol className="flex flex-col justify-center gap-1 rounded-[26px] border border-white/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.03),transparent)] p-3 md:p-7">
            {FEATURES.map((f, i) => {
              const on = i === active;
              return (
                <li
                  key={f.title}
                  onClick={() => setActive(i)}
                  className="cursor-pointer rounded-2xl p-4 transition-opacity duration-500 md:p-5"
                  style={{ opacity: on ? 1 : 0.4 }}
                >
                  <button
                    type="button"
                    aria-pressed={on}
                    className="flex items-center gap-2.5 font-display text-[19px] font-medium tracking-[-0.02em] text-ink outline-none focus-visible:underline"
                  >
                    <Icon name={f.icon} className="size-[18px] text-ink/80" />
                    {f.title}
                  </button>
                  <ul className="mt-3 space-y-2 text-[14px] leading-relaxed text-ink/70">
                    {f.points.map(([lead, rest]) => (
                      <li key={lead} className="flex gap-2.5">
                        <span aria-hidden className="mt-[9px] size-1 shrink-0 rounded-full bg-ink/50" />
                        <span>
                          <strong className="font-semibold text-ink">{lead}:</strong> {rest}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>

          <div className="relative min-h-[460px] overflow-hidden rounded-[26px] border border-white/[0.07] bg-[#030305] md:min-h-[580px]">
            <AnimatePresence initial={false}>
              <motion.div
                key={active}
                className="absolute inset-0"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: "38%" }}
                animate={{ opacity: 1, y: "0%" }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: "-38%" }}
                transition={{ duration: 1, ease: EASE }}
              >
                <Art />
              </motion.div>
            </AnimatePresence>

            <div className="absolute inset-x-0 bottom-5 z-10 flex justify-center gap-1.5">
              {FEATURES.map((f, i) => (
                <button key={f.title} type="button" aria-label={`Show ${f.title}`} onClick={() => setActive(i)} className="py-2">
                  <span className="block h-[2px] w-10 overflow-hidden rounded-full bg-white/15">
                    <motion.span
                      key={`${i}-${active}-${inView}`}
                      className="block h-full origin-left rounded-full bg-ink"
                      initial={{ scaleX: i < active ? 1 : 0 }}
                      animate={{ scaleX: i < active || (i === active && inView) ? 1 : 0 }}
                      transition={{ duration: i === active ? DWELL_MS / 1000 : 0.3, ease: "linear" }}
                    />
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/** The permission: a lavender seal with rings breathing out from it. */
function RingsArt() {
  return (
    <div className="absolute inset-0 grid place-items-center pb-8">
      {[118, 90, 64].map((size, i) => (
        <span
          key={size}
          aria-hidden
          className="absolute aspect-square rounded-full border"
          style={{ width: `${size}%`, borderColor: `rgba(255,255,255,${0.2 - i * 0.04})` }}
        />
      ))}
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className="absolute aspect-square w-[38%] animate-ripple rounded-full border border-lavender/50 motion-reduce:hidden"
          style={{ animationDelay: `${i * 1.2}s` }}
        />
      ))}
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 1, ease: EASE, delay: 0.15 }}
        className="relative grid aspect-square w-[38%] place-items-center rounded-full bg-[radial-gradient(circle_at_36%_26%,#f4f0ff_0%,#c9bcff_38%,#8f74f0_78%,#6d52d8_100%)] shadow-[0_0_90px_-6px_rgba(183,166,255,0.75),inset_0_2px_3px_rgba(255,255,255,0.7),inset_0_-10px_24px_rgba(60,30,140,0.35)]"
      >
        <Icon name="shieldCheck" className="w-[30%] text-[#2b1f63]" strokeWidth={1.6} />
      </motion.div>
    </div>
  );
}

/** Autopilot: a deck of plan cards rising out of a grid, the front one naming the schedule. */
function AutopilotArt() {
  const deck = [
    { left: "16%", width: "44%", height: "60%", delay: 0.22 },
    { left: "84%", width: "44%", height: "60%", delay: 0.22 },
    { left: "30%", width: "50%", height: "70%", delay: 0.12 },
    { left: "70%", width: "50%", height: "70%", delay: 0.12 },
  ];
  const lit = [
    { left: 92, top: 46 },
    { left: 230, top: 92 },
    { left: 368, top: 46 },
    { left: 46, top: 138 },
  ];
  return (
    <div className="absolute inset-0">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[62%] bg-[linear-gradient(rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.06)_1px,transparent_1px)] bg-[size:46px_46px] [mask-image:linear-gradient(to_bottom,#000_20%,transparent)]"
      >
        {lit.map((c, i) => (
          <span
            key={`${c.left}-${c.top}`}
            className="absolute size-[46px] animate-glow bg-white/[0.05] motion-reduce:animate-none"
            style={{ left: c.left, top: c.top, animationDelay: `${i * 0.8}s` }}
          />
        ))}
      </div>
      {deck.map((card) => (
        <motion.div
          key={card.left}
          aria-hidden
          className="absolute bottom-0 rounded-t-[26px] border border-white/[0.07] bg-[linear-gradient(180deg,#111116,#060608)]"
          style={{ left: card.left, width: card.width, height: card.height, x: "-50%" }}
          initial={{ y: 70, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 1, ease: EASE, delay: card.delay }}
        />
      ))}
      <motion.div
        className="absolute bottom-0 left-1/2 flex h-[80%] w-[58%] flex-col items-center rounded-t-[30px] border border-white/10 bg-[linear-gradient(180deg,#17171d_0%,#09090c_70%)] pt-[15%] shadow-[0_-30px_60px_-30px_rgba(0,0,0,0.9),inset_0_1px_0_rgba(255,255,255,0.08)]"
        style={{ x: "-50%" }}
        initial={{ y: 90, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 1, ease: EASE, delay: 0.05 }}
      >
        <span className="grid size-16 place-items-center rounded-full bg-[radial-gradient(circle_at_36%_28%,#f3ffd0_0%,#c8f53c_46%,#7aa70f_100%)] shadow-[0_0_46px_-4px_rgba(200,245,60,0.6),inset_0_2px_2px_rgba(255,255,255,0.7)]">
          <Icon name="repeat" className="size-7 text-[#10160a]" strokeWidth={2} />
        </span>
        <p className="mt-6 font-display text-[clamp(1.2rem,2vw,1.6rem)] font-medium tracking-[-0.02em]">Recurring buy</p>
        <p className="mt-1.5 text-[13px] text-ink/50">Runs on your rules.</p>
      </motion.div>
    </div>
  );
}

/** The trail: a receipt feeding out of the slot, over the one thing anyone should do with a receipt. */
function TrailArt() {
  return (
    <div className="absolute inset-0">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[30%] bg-[linear-gradient(180deg,#1c1c22,#0d0d11)] shadow-[0_18px_30px_-10px_rgba(0,0,0,0.9)]"
      />
      <div aria-hidden className="absolute left-[12%] right-[12%] top-[30%] h-[34%] rounded-b-[26px] border border-t-0 border-cobalt/40">
        <span className="absolute inset-y-0 left-1/2 w-px bg-cobalt/25" />
      </div>
      <div aria-hidden className="absolute left-1/2 top-0 h-[54%] w-[40%] -translate-x-1/2 overflow-hidden">
        <motion.div
          className="receipt h-full w-full bg-[linear-gradient(180deg,#2c2c33,#1d1d23)] px-[14%] pt-[44%]"
          initial={{ y: "-72%" }}
          animate={{ y: "0%" }}
          transition={{ duration: 1.8, ease: EASE, delay: 0.25 }}
        >
          <span className="block h-2 w-1/3 rounded-full bg-white/25" />
          <span className="mt-3 block h-2 w-full rounded-full bg-white/15" />
          <span className="mt-2 block h-2 w-full rounded-full bg-white/15" />
        </motion.div>
      </div>
      <motion.span
        aria-hidden
        className="absolute left-1/2 top-[64%] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-[linear-gradient(180deg,#86a2ff_0%,#2f5bff_60%,#2449d6_100%)] px-10 py-4 font-display text-[22px] font-medium text-white shadow-[0_0_60px_-4px_rgba(47,91,255,0.7),inset_0_1px_0_rgba(255,255,255,0.55),inset_0_-4px_10px_rgba(10,20,90,0.35)] ring-1 ring-white/25"
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.9, ease: EASE, delay: 0.7 }}
      >
        Verify
      </motion.span>
    </div>
  );
}
