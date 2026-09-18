import Image from "next/image";
import { BlurWords } from "@/components/motion/BlurWords";
import { LoopVideo } from "@/components/motion/LoopVideo";
import { Reveal } from "@/components/motion/Reveal";
import { Badge } from "@/components/ui/Badge";

/** The idea in one statement, flanked by how the permission works and how it ends. */
export function Solution() {
  return (
    <section className="relative px-4 pt-16 sm:px-8 md:pt-20">
      <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
        <Reveal className="relative aspect-video w-[min(560px,92vw)] mix-blend-lighten [mask-image:radial-gradient(closest-side,#000_55%,transparent)]">
          <LoopVideo
            className="absolute inset-0 h-full w-full object-cover"
            poster="/media/rings.jpg"
            sources={[
              { src: "/media/rings.webm", type: "video/webm" },
              { src: "/media/rings.mp4", type: "video/mp4" },
            ]}
          />
        </Reveal>
        <Reveal delay={0.1} className="-mt-4">
          <Badge>How it works</Badge>
        </Reveal>
        <h2 className="mt-6 text-balance font-display text-[clamp(1.9rem,3.7vw,3.3rem)] font-medium leading-[1.12] tracking-[-0.035em]">
          <BlurWords stagger={0.045} text={"Handing a bot your money is\na trust problem, so the\npermission is the product."} />
        </h2>
      </div>

      <div className="mx-auto mt-14 grid max-w-5xl items-center gap-8 md:grid-cols-[1fr_minmax(0,380px)_1fr]">
        <Reveal>
          <p className="mx-auto max-w-sm text-center text-[15px] leading-relaxed text-ink/70 md:mx-0 md:text-left">
            <span className="font-medium text-ink">XorrDelegation</span> is a contract you grant. It caps what the bot can
            spend per day, restricts it to venues you allowlisted, and expires on its own.
          </p>
        </Reveal>
        <Reveal delay={0.15} className="relative mx-auto aspect-[4/3] w-full max-w-[380px] mix-blend-lighten">
          <div className="absolute inset-0 animate-float-slow [mask-image:radial-gradient(50%_50%_at_50%_50%,#000_55%,transparent)] motion-reduce:animate-none">
            <Image src="/media/vault.webp" alt="" fill sizes="380px" className="object-cover" />
          </div>
        </Reveal>
        <Reveal delay={0.3}>
          <p className="mx-auto max-w-sm text-center text-[15px] leading-relaxed text-ink/70 md:ml-auto md:mr-0 md:text-right">
            Revoking takes one signature from you and nothing from us. Everything the bot does is readable back off the
            chain.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
