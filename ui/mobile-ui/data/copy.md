# copy.json is markets.json's sibling — every string lives with its data.

All user-facing strings are stored alongside their data in `markets.json`, and screen-level
copy (titles, subtitles, buttons, footnotes) is quoted inline in `screens.md` under each screen's
**Copy** heading. There is no separate copy file to drift out of sync.

## Voice rules

- **Plain and specific.** "Every trade waits for your approval", not "Enhanced control mode".
- **Second person, present tense.** The app addresses the user; agents refer to themselves by name.
- **Name the consequence, not the feature.** "A 9% move against you wipes the margin." not
  "High leverage carries risk."
- **Never oversell an agent.** Every performance surface carries a disclaimer:
  "Past performance of a strategy says nothing about tomorrow." ·
  "All agents can make mistakes. Markets are risky." · "Nothing here is a promise."
- **No exclamation marks. No emoji.** Not one anywhere in the app.
- **Agent messages are first person and factual**, and always state what they did or will do —
  never just an observation. "Yield Keeper: moved \$1,240 of idle cash in. Unlock is 3 days."
