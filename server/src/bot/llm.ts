/**
 * The bot runtime — PLAN.md 12.18 / 11.7.
 *
 * Calls a real model through OpenRouter. Everything it returns is treated as UNTRUSTED PROSE:
 * the output is validated against the voice contract before it can reach a screen, and any number
 * it invents is rejected rather than rendered.
 */
import 'dotenv/config';
import { PERSONAS, systemPrompt, type PersonaId, type Venue } from './personas.js';
import { CHAIN_KEY } from '../evm/chains.js';
import { TOKENS } from '../venues/oneinch.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Overridable, because free-tier model availability moves around.
 *
 * MEASURED, not assumed (src/bot/bench.ts, 2026-09-05): across the five free models reachable on
 * this account, contract compliance ranged from 0/4 to 2/4. `liquid/lfm-2.5-2.6b:free` was the
 * best and is the default so the app works without a paid credential — but a production
 * deployment should set XORR_MODEL to a frontier model, where the constraint is easy. This is a
 * MODEL-QUALITY limitation, not an architectural one: every non-compliant output is rejected at
 * the gate, so a weak model makes the bot terser, never wrong.
 */
export const MODEL = process.env.XORR_MODEL ?? 'liquid/lfm-2.5-2.6b:free';

/**
 * Whether anything can write a line at all.
 *
 * Without a key every `speak` answers `no_key`, so an app offering questions to its agents offers a dead end. `/health`
 * publishes this, and the conversation offers the agent's own screens instead.
 */
export function voiceConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export type LlmResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: 'no_key' | 'rejected' | 'error'; detail: string };

const DIGIT = /\d/;
const NUMBER_WORDS =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|halves|quarter|quarters|third|thirds|double|doubled|doubles|doubling|triple|tripled|triples|tripling)\b/i;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

export type VoiceViolation = 'number' | 'number_word' | 'emoji' | 'exclamation' | 'empty' | 'too_long';

/**
 * The gate. PLAN.md §3.2: enforced structurally, not by prompting — a model that ignores the
 * system prompt does not get its prose on screen.
 */
export function validateVoice(text: string): { ok: true } | { ok: false; violations: VoiceViolation[] } {
  const violations: VoiceViolation[] = [];
  const t = text.trim();
  if (!t) violations.push('empty');
  if (DIGIT.test(t)) violations.push('number');
  if (NUMBER_WORDS.test(t)) violations.push('number_word');
  if (EMOJI.test(t)) violations.push('emoji');
  if (t.includes('!')) violations.push('exclamation');
  if (t.length > 400) violations.push('too_long');
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Strip the things a model adds by reflex, before validating. */
function tidy(text: string): string {
  return text
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One repair attempt before giving up.
 *
 * The free-tier models available here follow the "never write a number" rule only about a fifth
 * of the time — measured, not assumed (see llm.live.test.ts). Rejecting outright would make the
 * bot mute. Rejecting and then telling the model exactly which rule it broke recovers most of it,
 * and anything that fails twice falls back to the persona's own written line.
 *
 * The gate never loosens: a repaired message still has to pass validateVoice.
 */
const REPAIR_HINT: Record<VoiceViolation, string> = {
  number: 'You wrote a figure. Remove every digit; the app renders numbers itself.',
  number_word: 'You wrote a number in words. Remove it; the app renders numbers itself.',
  emoji: 'You used an emoji. Remove it.',
  exclamation: 'You used an exclamation mark. Remove it.',
  empty: 'You wrote nothing. Write one short sentence.',
  too_long: 'Too long. Two sentences at most.',
};

/**
 * The venue every persona is told about.
 *
 * `TOKENS` is the registry the executor actually routes against, so this cannot drift from what a
 * fill can touch — which is the whole point. It is deliberately NOT `/market/tradable`: that route
 * probes the chain to see whether the equities function on a fork, and a system prompt must not
 * cost an RPC round trip on every message. Naming a token the fork cannot settle is a much smaller
 * error than describing a market that does not exist here at all.
 */
const VENUE: Venue = {
  chain: CHAIN_KEY === 'xlayer-testnet' ? 'Base Sepolia' : 'Base',
  tradable: Object.keys(TOKENS),
};

export async function speak(params: {
  persona: PersonaId;
  toneInstruction: string;
  /** What actually happened, in words with no figures — the model narrates, it does not compute. */
  situation: string;
  timeoutMs?: number;
  /** Internal: the repair pass sets this false so a failure cannot recurse. */
  allowRepair?: boolean;
}): Promise<LlmResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return { ok: false, reason: 'no_key', detail: 'OPENROUTER_API_KEY is not set.' };
  }

  const persona = PERSONAS[params.persona];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? 30_000);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'x-title': 'xorr',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 160,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt(persona, params.toneInstruction, VENUE) },
          { role: 'user', content: params.situation },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: 'error', detail: `${res.status} ${body.slice(0, 200)}` };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content ?? '';
    const text = tidy(raw);
    const check = validateVoice(text);
    if (check.ok) return { ok: true, text, model: MODEL };

    if (params.allowRepair === false) {
      return { ok: false, reason: 'rejected', detail: check.violations.join(',') };
    }

    const hints = check.violations.map((v) => REPAIR_HINT[v]).join(' ');
    const repaired = await speak({
      ...params,
      allowRepair: false,
      situation: `${params.situation}\n\nYour previous answer broke the rules and was discarded. ${hints} Rewrite it.`,
    });
    if (repaired.ok) return repaired;
    return { ok: false, reason: 'rejected', detail: check.violations.join(',') };
  } catch (e) {
    return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

