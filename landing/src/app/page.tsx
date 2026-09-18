import { SmoothScroll } from "@/components/SmoothScroll";
import { Cta } from "@/components/sections/Cta";
import { Features } from "@/components/sections/Features";
import { Hero } from "@/components/sections/Hero";
import { Overview } from "@/components/sections/Overview";
import { Solution } from "@/components/sections/Solution";
import { StackedSheets } from "@/components/sections/StackedSheets";

export default function Home() {
  return (
    <main className="pb-3">
      <SmoothScroll />
      <StackedSheets
        first={
          <div className="mx-2 mt-2 overflow-hidden rounded-[32px] border border-white/[0.06] bg-[#060608] sm:mx-3 sm:mt-3">
            <Hero />
            <Overview />
          </div>
        }
        second={
          <div className="relative mx-2 mt-3 overflow-hidden rounded-[32px] border border-white/[0.09] bg-[#040612] sm:mx-3">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_42%_at_50%_0%,rgba(47,91,255,0.42),rgba(20,40,150,0.16)_45%,transparent_75%),radial-gradient(70%_30%_at_50%_100%,rgba(47,91,255,0.2),transparent_70%)]"
            />
            <div aria-hidden className="noise pointer-events-none absolute inset-0" />
            <div className="relative">
              <Solution />
              <Features />
              <Cta />
            </div>
          </div>
        }
      />
    </main>
  );
}
