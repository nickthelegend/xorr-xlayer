import { APP_URL } from "@/lib/links";

const ORBITS = [
  {
    size: 240,
    duration: 16,
    offset: -4,
    dot: "bg-[radial-gradient(circle_at_35%_30%,#b9c8ff,#2f5bff_60%,#172a8a)] shadow-[0_0_16px_rgba(47,91,255,0.9)]",
  },
  {
    size: 370,
    duration: 26,
    offset: -17,
    dot: "bg-[radial-gradient(circle_at_35%_30%,#f1ffc9,#c8f53c_60%,#6f9c0e)] shadow-[0_0_16px_rgba(200,245,60,0.8)]",
  },
  {
    size: 500,
    duration: 38,
    offset: -9,
    dot: "bg-[radial-gradient(circle_at_35%_30%,#efe9ff,#b7a6ff_60%,#6d52d8)] shadow-[0_0_16px_rgba(183,166,255,0.8)]",
  },
];

/** Concentric orbits with a body on each, circling the one button that matters. Pure CSS: it never stops a frame. */
export function OrbitCta() {
  return (
    <div className="relative mt-auto h-[250px] w-full">
      <div className="absolute left-1/2 top-[64%]">
        {ORBITS.map((o) => (
          <span
            key={o.size}
            aria-hidden
            className="absolute rounded-full border border-white/[0.11]"
            style={{ width: o.size, height: o.size, left: -o.size / 2, top: -o.size / 2 }}
          />
        ))}
        {ORBITS.map((o) => (
          <span
            key={`body-${o.size}`}
            aria-hidden
            className="absolute animate-orbit motion-reduce:animate-none"
            style={{
              width: o.size,
              height: o.size,
              left: -o.size / 2,
              top: -o.size / 2,
              animationDuration: `${o.duration}s`,
              animationDelay: `${o.offset}s`,
            }}
          >
            <span className={`absolute left-1/2 top-0 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${o.dot}`} />
          </span>
        ))}
        <a
          href={APP_URL}
          className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-[linear-gradient(180deg,#e2ff8a_0%,#c8f53c_55%,#a9d62a_100%)] px-7 py-3.5 font-display text-[17px] font-medium text-[#0c1003] shadow-[0_22px_44px_-14px_rgba(200,245,60,0.6),inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-3px_8px_rgba(60,80,0,0.25)] ring-1 ring-black/20 transition-transform duration-150 ease-out active:scale-[0.97]"
        >
          Open the app
        </a>
      </div>
    </div>
  );
}
