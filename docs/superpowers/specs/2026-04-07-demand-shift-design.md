# Demand Shift — Design Specification

**Status:** Draft for implementation  
**Date:** 2026-04-07  

## 1. Purpose

Build a **client-side-only** web application for **consumers** who upload **interval electricity usage** (CSV). The app computes **energy cost** under user-defined **rate plans**, compares **alternate plans**, and (later) explores **what-if** scenarios involving **alternative energy** (generator, solar, batteries with off-peak charging).

**Non-goals for v1:** Server-side storage, accounts, native installs, or importing rate plans from PDF/utility portals (guided manual entry only).

## 2. Principles

- **Consumer-friendly:** Guided flows, plain language, sensible defaults; advanced detail behind progressive disclosure.
- **Privacy:** Data never leaves the device unless the user explicitly exports. Optional persistence only in browser storage.
- **Single source of truth:** One billing/calculation engine drives totals, comparisons, and (later) charts.

## 3. Usage data (CSV)

### 3.1 Expected shape

The app accepts CSV with headers similar to:

`Name`, `Address`, `Account #`, `CUSTOMER CODE`, `PREMISE CODE`, `MeterID`, `ServiceType`, `channelNumber`, `powerFlow`, `unit`, `intervalLength`, `TimeZone`, `startTime`, `endTime`, `Startdate`, `Start Time`, `End Date`, `End Time`, `TIME OF USE`, `Read Type`, `Usage`, `Day of the week`, `Hour of the day`, `Cost`

### 3.1.1 Required columns (reject if missing)

After normalizing header names (**trim whitespace; compare case-insensitively**), the file **must** satisfy all of the following or the CSV is **rejected** with a clear error listing what is missing:

1. **`Usage`** — interval energy (kWh).
2. **`TimeZone`** — IANA or known label used to interpret timestamps (see implementation for supported values).
3. **A complete timestamp pair** (either option **a** or **b**):
   - **a)** **`startTime`** and **`endTime`**, each parseable as a full date-time for the row, **or**
   - **b)** **`Startdate`**, **`Start Time`**, **`End Date`**, and **`End Time`**, such that start and end instants can be constructed for each row.

Optional columns may be present or absent; absence does not reject the file unless a required column is missing or unusable.

### 3.2 Normalization

- Parse rows into canonical **intervals**: at minimum **`start` (instant)**, **`end` (instant)**, **`kWh` (numeric)** from `Usage`, plus timezone from `TimeZone` or user confirmation.
- Ignore or optionally validate ancillary columns (`TIME OF USE`, `Cost`, etc.) for future features; **billing uses user-defined rates**, not CSV `Cost`, unless a future mode explicitly requests reconciliation.

### 3.3 Parsing and performance

- Use the **File API** in-browser; optionally a **Web Worker** for large files so the UI stays responsive.

### 3.4 Multiple usage datasets

- Users may **upload more than one** usage CSV over time. Each successful upload is stored as a distinct **usage dataset** (e.g. default **label** from the original filename; user may **rename** for clarity).
- The UI provides a **list of saved datasets** with enough context to choose one (**date range** of intervals, row count, label). The user **selects** which dataset drives **current** cost results, plan compare, and (later) charts—unless the product later adds explicit multi-dataset views.
- Users may **remove** a dataset from storage; **clear all** remains available in settings (see §8).

## 4. Rate plans (guided entry, saved locally)

### 4.1 Concepts

- Each **rate plan** has a **name** and is **saveable** in browser storage alongside **one or more** stored usage datasets (§3.4).
- A plan **covers a single calendar year, January 1 through December 31** (inclusive): one or more **rate periods** partition that year with **no gaps** and **no overlapping** days. **Periods do not wrap** across the New Year (e.g. there is no single period from November through January); the user defines **Jan 1–Dec 31** coverage only.

### 4.2 Rate period — calendar span

- Each period has:
  - **Start day of year** (month + day, within **Jan 1–Dec 31**).
  - **End day of year** (month + day, within **Jan 1–Dec 31**).
- **Inclusive date semantics:** If the period runs from January 1 through May 31, **every instant** on January 1 and **every instant** on May 31 belongs to that period, including 23:59:59 on those days.

### 4.3 February 28 and February 29

- **February 28** may be used as the **start** or **end** day of a rate period (subject to full-year coverage and non-overlap rules).
- **February 29** must **not** appear as a selectable **start** or **end** day in the rate-plan UI (it does not exist in non–leap years). **Cost calculation** for usage on **February 29** in a leap year uses the **same rate period** and the **same peak time-of-day windows and base/peak $/kWh** as **February 28** in that year. **Weekday-based** peak rules (e.g. Mon–Fri) use **February 29’s real** day of week, not February 28’s.

### 4.4 Rates within a period

- **Base rate:** $/kWh applied by default for usage in that period.
- **Optional peak (v1):** At most **one** peak definition per period:
  - **Peak rate:** $/kWh.
  - **Weekdays:** Subset of Mon–Sun on which peak can apply.
  - **Time range:** Local time window on those weekdays.

**Billing rule:** For an interval whose timestamp falls in this period, use **peak** $/kWh only if the instant matches **peak weekday** and **peak time window** rules; otherwise use **base** $/kWh. Days outside the peak weekday set use **base** for the entire day.

### 4.5 Peak time window semantics

- Times are interpreted in the **billing timezone** (see §6).
- **Start exclusive, end inclusive:** For a window labeled `18:00` to `21:00` on a given civil day, an instant `t` is in the peak window if **`t > 18:00` and `t ≤ 21:00`**.
- **Overnight windows** are **allowed** when **end time ≤ start time** (e.g. `22:00` to `06:00`): interpret as one continuous window that **crosses midnight**—`t` is in peak if **`t > start`** on the **first calendar day** of the window **or** **`t ≤ end`** on the **following** calendar day, for days where the peak **weekday** rule applies on the relevant portion. (Implementation must document exact boundary behavior at exactly `start` and `end` to match **exclusive start / inclusive end** across the wrap.)
- **Non-overlap:** Peak windows **must not overlap** with each other. For v1 (**one** peak window per period), this is satisfied by construction; if multiple windows are added later, **pairwise non-overlap** is required (validation rejects overlaps).

### 4.6 Validation before save

1. **Full coverage:** Every calendar day that appears on a **non–leap-year** calendar from **Jan 1–Dec 31** (365 days) must lie in **exactly one** period. In **leap years**, usage on **Feb 29** is **not** given its own period row; it **inherits** the **same** period as **Feb 28** (see §5). Thus period definitions never use **Feb 29** as a boundary, and **full coverage** is validated on the **365-day** template; leap-day usage is handled only in **cost calculation**.
2. **No overlap:** No day appears in two periods (for period **definition**, only **Jan 1–Dec 31** days that exist in a non–leap-year template; Feb 29 is not a period boundary).
3. **Boundary rule:** No period may start or end on **Feb 29** (Feb **28** is allowed).

## 5. Cost calculation

- For each usage interval, determine **calendar day** and **time** in billing timezone → **rate period** → **base vs peak** → **$/kWh**.
- **Leap day (Feb 29):** Usage on **February 29** uses the **same rate period** (season segment and base/peak **$/kWh** and **clock** windows) as **February 28** in that calendar year. **Day-of-week** rules for peak (e.g. Mon–Fri) use **February 29’s actual** weekday—only the **period** and **time-of-day** table are aligned with Feb 28, not a fictional calendar date.
- **Cost for interval** = `kWh × applicable_rate`.
- Aggregate **totals**, **by period**, **by TOU-like bucket** (base vs peak), and (later) **by month** for charts.

## 6. Timezone

- Default to CSV `TimeZone` when reliable; allow user override for **billing** (TOU boundaries). Document that mismatches between meter and billing TZ affect peak assignment.

## 7. Product flow (UX)

1. **Upload / confirm usage** (and timezone if needed); **add** additional CSVs anytime. **Pick** the active dataset from the saved list when more than one exists.
2. **Define or load a rate plan** (guided); validate before save.
3. **Results:** Total cost and breakdown under current plan (for the **selected** dataset).
4. **Compare:** Second plan (saved or ad hoc) → side-by-side totals and difference ($ and %).
5. **Later — what-if:** Generator / solar / battery (battery may charge off-peak); reuse the same engine on **modified** interval series from the selected dataset.

## 8. Persistence

- **Optional:** **IndexedDB** holds **multiple** usage datasets (parsed intervals + metadata per upload) and **saved rate plans**. **localStorage** for small preferences only (e.g. last-selected dataset id).
- **Per-dataset delete** and **clear all** usage data / plans in settings; destructive actions confirm before proceeding.
- **Export (optional later):** User-owned summaries or anonymized aggregates only; no server upload.

## 9. Phasing

| Phase | Scope |
|--------|--------|
| **A** | Multiple CSV uploads, per-dataset storage, dataset picker, normalization, saved rate plans, full-year validation, cost totals + base/peak breakdown, plan compare |
| **B** | Charts (aggregates already computed by engine) |
| **C** | DER what-if: simplified solar/generator/battery models aligned to interval granularity |

## 10. Implementation plan inputs (resolved)

The following were open for the implementation plan; they are **decided** here:

| Topic | Decision |
|--------|-----------|
| **CSV headers** | **§3.1.1:** Required columns; **reject** the file if any required header is missing (case-insensitive, trimmed). |
| **Overnight peak** | **Allowed**; **§4.5** defines crossing-midnight behavior with **exclusive start / inclusive end** (exact instant rules at the wrap to be spelled out in code/tests). |
| **Peak overlap** | **Not allowed**; **§4.5**. v1 has one window per period; future multi-window must stay non-overlapping. |
| **Feb 28 / Feb 29** | **§4.3, §4.6, §5:** Feb **28** allowed as period boundary; Feb **29** not a boundary; usage on Feb **29** inherits Feb **28’s** period and clock-based peak table; **weekday** rules use **Feb 29’s actual** DOW. |
| **Plan year** | **Jan 1–Dec 31** only; **no** single period wrapping across New Year—**§4.1**. |
| **Usage storage** | **§3.4, §8:** Multiple uploads; each dataset stored separately in IndexedDB; user selects **active** dataset for analysis. |

**Remaining for implementation (mechanical):** Parser details (delimiter, quoting, encoding), exact **TimeZone** string catalog, overnight edge-case **unit tests** (intervals straddling midnight), and user-facing error strings for CSV rejection.

---

## 11. Spec self-review (2026-04-07)

- **Placeholders:** §10 defers only mechanical/parser/testing details, not product ambiguity.
- **Consistency:** Inclusive period dates; exclusive-start/inclusive-end peak times; overnight allowed; Feb 29 handled only in **cost** path, not as a defined period endpoint.
- **Scope:** Single coherent v1 (Phase A) with clear later phases; multiple usage datasets supported from Phase A.
- **Leap years:** Feb 29 inherits Feb 28’s period and TOU **clock** rules; **weekday** mask uses Feb 29’s actual DOW; period validation does not require a Feb 29 endpoint.
