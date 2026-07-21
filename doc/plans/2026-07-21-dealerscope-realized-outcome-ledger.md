# DealerScope Realized-Outcome Ledger (Settlement Loop)

Date: 2026-07-21

## Context

DealerScope runs as an agent company on this Paperclip deployment. The platform
already contains a double-entry finance ledger (`finance_events`) with
debit/credit direction, amounts in cents, and foreign keys to the agent, issue,
project, goal, heartbeat run, and cost event that generated the money movement
(`packages/db/src/schema/finance_events.ts`). The net-position query
(`server/src/services/finance.ts`) and the UI credit rendering already exist.

Audit findings that motivate this plan:

- No code path anywhere in the repo ever writes a `credit` finance event. The
  only credit in the codebase is a Storybook mock. `FINANCE_DIRECTIONS`
  (`packages/shared/src/constants.ts`) is half dead.
- Agents may report cost events (`server/src/routes/costs.ts`) but finance
  events are board-only. Revenue attribution has no write path at all.
- Budget enforcement (`server/src/services/budgets.ts`) reads only
  `cost_events`. Budgets are spend caps with no awareness of returns.
- `finance_events` has query indexes but no uniqueness constraint — nothing
  prevents the same settlement from being booked twice.

Consequence: the system measures what DealerScope's intelligence costs, but
never what it earns. Every flip recommendation that closes profitably is
invisible to the platform's own accounting.

## Goal

Build a trustworthy chain:

```
recommendation → purchase → complete deal costs → sale → realized profit → learning
```

Explicitly NOT the goal (yet): automatic budget reallocation ("maximizer
mode"). The ledger is measurement-first. Capital-allocation behavior is gated
behind a reliability threshold defined in Phase 3.

## Design principles

1. **Agents never book revenue.** All settlement writes go through a verified
   settlement path (board action or an approval-gated settlement routine).
   Agents can *propose* a settlement; only the settlement path can commit it.
2. **Full deal costing, not sale-price-as-revenue.** A settled flip is a
   bundle of ledger legs, not one credit. Booking only the sale price would
   make an $8,000 purchase sold at $10,000 look like a $10,000 win.
3. **Append-only with reversals.** No updates or deletes to settled legs.
   Corrections are reversing entries referencing the original.
4. **Idempotent by deal.** One settlement per deal, enforced by the database,
   not by convention.
5. **Attribution carries confidence.** The link from settlement back to the
   originating recommendation/agents is recorded with a confidence level, so
   downstream learning can weight or exclude weak attributions.

## Data model

### Settlement (new concept, `deal_settlements`)

One row per completed flip:

- `dealKey` — stable external key (VIN + acquisition date, or auction lot id).
  Unique per company. This is the idempotency anchor.
- `vin`, `vehicleDescription`, `soldAt`
- `originIssueId` — the opportunity/recommendation issue
- `originGoalId` — the strategy under test
- `attributionConfidence` — `exact | strong | inferred`
- `status` — `draft | committed | reversed`
- Denormalized realized figures for cheap reads: `acquisitionCents`,
  `reconHoldingCents`, `saleProceedsCents`, `realizedGrossCents`,
  `realizedNetCents`
- `committedByUserId`, `committedAt`

### Ledger legs (existing `finance_events`, one per money movement)

Each settlement commits a set of finance events sharing
`metadataJson.settlementId` and the origin issue/goal/agent keys:

| eventKind             | direction | example                    |
| --------------------- | --------- | -------------------------- |
| `deal_acquisition`    | debit     | hammer price               |
| `deal_auction_fee`    | debit     | buyer fee                  |
| `deal_transport`      | debit     | hauling                    |
| `deal_title_reg`      | debit     | title/registration         |
| `deal_recon`          | debit     | repairs and recon          |
| `deal_holding`        | debit     | storage, floorplan interest |
| `deal_sale_expense`   | debit     | listing/sale costs         |
| `deal_sale_proceeds`  | credit    | gross sale proceeds        |
| `deal_adjustment`     | either    | refunds, arbitration, corrections |

Realized net for the deal = credits − debits across its legs, which the
existing `netCents` summary computes with no changes. Token/agent operating
costs stay in `cost_events` keyed to the same issue/goal, so "did this deal
clear net of the AI spend that found it" is a join, not new infrastructure.

Schema changes required:

- New `deal_settlements` table with `unique(companyId, dealKey)`.
- Partial unique index on `finance_events` for settlement legs
  (`companyId, metadataJson->>'settlementId', eventKind`) or a
  `settlementId` column with a composite unique — pick during implementation.
- `reversesFinanceEventId` (nullable self-reference) for correcting entries.

## Write path

1. An agent (or human) drafts a settlement: legs, dealKey, origin links,
   attribution confidence. Draft is inert — no ledger writes.
2. The settlement passes through the existing approval machinery
   (`issue-approvals` / board action). Approval is the only transition from
   `draft` to `committed`.
3. Commit inserts all legs in one transaction and stamps denormalized totals.
   A duplicate `dealKey` commit fails loudly.
4. Reversal creates a mirrored set of legs and marks the settlement
   `reversed`; a corrected settlement is a new settlement with a new revision
   of the same dealKey (`dealKey#2`) — history stays intact.

## Phases

### Phase 0 — Ledger + settlement (measurement only)

The tables, the settlement write path, the approval gate, idempotency,
reversals. Manual/board-driven settlement entry is acceptable here. Exit
criteria: a real closed flip recorded end-to-end with full deal costing and
correct net.

### Phase 1 — Attribution reporting

Read-model views over settlements + cost_events: realized net per agent, per
goal/strategy, per make/model segment, per data source (from origin issue
metadata); ROI of AI spend per deal. Reporting only — no behavior changes.

### Phase 2 — Learning ingestion

Feed settled deals into the evals pipeline as production cases
(`evals/` Phase 4: production-case ingestion). A settled deal is a labeled
example: decision context (issue thread, work products) → realized dollars.
Grade recommendation quality against realized outcomes, not predicted margin.

### Phase 3 — Outcome-aware budgeting (gated)

Only after a minimum corpus of committed settlements (proposed: ≥30 settled
deals per strategy and ≥1 full quarter of data) and demonstrated attribution
reliability: let budget policy consult realized net per goal — widen budgets
on net-positive strategies, tighten on net-negative. Board approval required
to enable; hard caps remain as the outer bound.

## Non-goals

- Automatic revenue detection from external systems (DMS integration can feed
  drafts later; it is not required for Phase 0).
- Agent-initiated ledger commits, in any phase.
- Forecast/predicted-profit accounting in the ledger. `estimated=true` events
  are allowed only as clearly-marked provisional legs and must be reversed or
  confirmed at settlement.
