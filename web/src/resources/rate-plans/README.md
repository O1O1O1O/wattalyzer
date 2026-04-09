# Built-in rate plan templates

JSON files here are **sample schedules** for Wattalyzer’s **Import built-in** list. They use the same shape as exported plans (no `id` fields—those are assigned on import).

- Add a new file, then register it in `../builtinRatePlans.ts`.
- Prefer including a **`rateScheduleUrl`** when you have a public utility tariff page (https only).

See `../../lib/ratePlanJson.ts` for the full import/export format (`wattalyzerRatePlans` wrapper or bare `plans` array).
