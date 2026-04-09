# Wattalyzer

Client-side web app for exploring **interval electricity usage** (CSV) against **user-defined rate plans**, with optional **battery storage analysis** on the **Analyze** tab (modeled grid import). Everything runs in the browser: no account, no backend.

## Features

- **Usage data** — Import CSV with `Usage`, `TimeZone`, and interval timestamps; store multiple datasets, rename labels, set billing time zone per dataset.
- **Rate plans** — Define named plans with calendar periods (Jan 1–Dec 31 coverage), base $/kWh, optional peak windows; optional **rate schedule URL** (opens in a new tab in the list and when editing).
- **Plan sharing** — **Export all plans** to a JSON file; **import** from that Wattalyzer format, a `{ "plans": [...] }` file, or a single plan object. **Built-in templates** ship under `src/resources/rate-plans/` and are registered in `src/resources/builtinRatePlans.ts`.
- **Battery banks** — Configure capacity, efficiency, limits; **Analyze** tab runs a simple dispatch model and records results in a comparison table.
- **Analytics** — Estimated bill (base/peak/total), sliding-window kWh distributions, peak-only stats; Analyze rows link to full detail for a selected run.
- **Storage** — Datasets, plans, and batteries persist in **IndexedDB**; UI preferences use **localStorage**. **Clear all data** wipes local stores.

Billing math is for exploration only—always verify against your utility.

## Requirements

- [Node.js](https://nodejs.org/) (LTS recommended)

## Scripts

From this directory (`web/`):

| Command           | Description                            |
| ----------------- | -------------------------------------- |
| `npm install`     | Install dependencies                   |
| `npm run dev`     | Vite dev server (HMR)                  |
| `npm run build`   | Typecheck + production build → `dist/` |
| `npm run preview` | Serve the production build locally     |
| `npm test`        | Vitest unit tests                      |
| `npm run lint`    | ESLint                                 |

## Project layout

- `src/App.tsx` — Main UI and tab shell
- `src/lib/` — CSV parsing, billing, rate-plan validation, `ratePlanJson` (import/export), usage analytics, IndexedDB, battery analysis (`batterySimulation` module)
- `src/resources/rate-plans/` — Built-in JSON plan templates (+ README)
- `src/resources/builtinRatePlans.ts` — Built-in list and import helper
- `src/BillGridUsageAnalytics.tsx` — Shared bill + grid analytics block

Design notes: [`../docs/superpowers/specs/2026-04-07-demand-shift-design.md`](../docs/superpowers/specs/2026-04-07-demand-shift-design.md)

## Stack

React 19, TypeScript, Vite, Luxon, Papa Parse, idb.
