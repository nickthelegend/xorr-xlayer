import { AgentShuffle } from "@/components/bento/AgentShuffle";
import { KeysStack } from "@/components/bento/KeysStack";
import { OrbitCta } from "@/components/bento/OrbitCta";
import { RuleTracks } from "@/components/bento/RuleTracks";
import { BlurWords } from "@/components/motion/BlurWords";
import { Reveal } from "@/components/motion/Reveal";
import { Badge } from "@/components/ui/Badge";
import { Arc, Card } from "@/components/ui/Card";

/** The heading under the hero and the four-tile bento — what the bot is, and the limits it lives inside. */
export function Overview() {
  return (
    <section className="relative px-3 pb-20 pt-16 sm:px-8 md:pb-28 md:pt-24">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <Reveal>
          <Badge>Welcome to xorr</Badge>
        </Reveal>
        <h2 className="mt-6 text-balance font-display text-[clamp(2.25rem,4.4vw,3.75rem)] font-medium leading-[1.04] tracking-[-0.04em]">
          <BlurWords text="Trading you can hand off" />
        </h2>
        <Reveal delay={0.35}>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink/55">
            Recurring buys, stops that hold and a one-tap stop — all inside a permission you control.
          </p>
        </Reveal>
      </div>

      <div className="mx-auto mt-14 grid max-w-6xl gap-4 md:grid-cols-[1.4fr_1fr]">
        <Card className="flex min-h-[420px] flex-col p-7 md:p-9">
          <Arc className="-left-44 top-[30%]" />
          <div className="flex flex-1 items-center justify-center py-8">
            <AgentShuffle />
          </div>
          <h3 className="font-display text-[clamp(1.4rem,2.2vw,1.75rem)] font-medium tracking-[-0.025em]">
            Four agents, one mandate each
          </h3>
          <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-ink/55">
            Momentum Scout, Yield Keeper, Drawdown Guard and Earnings Desk each watch for one thing — and act only inside
            the limits you set.
          </p>
        </Card>

        <Card delay={0.1} className="flex min-h-[420px] flex-col">
          <Arc className="-left-36 top-[58%]" />
          <p className="relative max-w-[21rem] p-7 font-display text-[17px] leading-snug text-ink/90 md:p-9">
            Every trade clears the same gates: your daily cap, the venues you allowlisted, and a permission that expires
            on its own.
          </p>
          <RuleTracks className="mt-auto w-full" />
        </Card>
      </div>

      <div className="mx-auto mt-4 grid max-w-6xl gap-4 md:grid-cols-[1fr_1.4fr]">
        <Card className="flex min-h-[400px] flex-col">
          <p className="relative z-10 max-w-[19rem] p-7 font-display text-[17px] leading-snug text-ink/90 md:p-9">
            Grant the permission once. Revoke it in one tap, with no cooperation needed from us.
          </p>
          <OrbitCta />
        </Card>

        <Card delay={0.1} className="flex min-h-[400px] flex-col p-7 md:p-9">
          <div className="relative flex flex-1 items-center justify-center py-6">
            <KeysStack />
          </div>
          <h3 className="font-display text-[clamp(1.4rem,2.2vw,1.75rem)] font-medium tracking-[-0.025em]">
            Your keys never leave you
          </h3>
          <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-ink/55">
            Non-custodial by design. The bot trades inside a scoped on-chain permission and cannot move funds to an
            address of its choosing.
          </p>
        </Card>
      </div>
    </section>
  );
}
