/** Tone instructions, mirrored from the app's src/bot/tone.ts. PLAN.md 11.4. */
export const TONE_INSTRUCTIONS = {
  dry: 'Write plainly with dry understatement. One short aside at most, and only about the market — never about the user or their money.',
  sharp:
    'Be more opinionated and direct about market conditions. Stay factual about positions, sizes and limits. Never mock the user.',
  flat: 'No personality. State only what happened and what will happen next.',
} as const;

export type ToneId = keyof typeof TONE_INSTRUCTIONS;
