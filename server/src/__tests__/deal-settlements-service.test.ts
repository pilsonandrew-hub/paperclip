import { describe, expect, it } from "vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, companies, dealSettlements, financeEvents } from "@paperclipai/db";
import { createDealSettlementSchema, createFinanceEventSchema } from "@paperclipai/shared";
import { computeSettlementTotals, dealSettlementService } from "../services/deal-settlements.ts";
import { financeService } from "../services/finance.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("computeSettlementTotals", () => {
  it("computes acquisition, recon/holding, proceeds, gross, and net buckets", () => {
    const totals = computeSettlementTotals([
      { eventKind: "deal_acquisition", direction: "debit", amountCents: 750_000, description: null, occurredAt: null, estimated: false },
      { eventKind: "deal_auction_fee", direction: "debit", amountCents: 40_000, description: null, occurredAt: null, estimated: false },
      { eventKind: "deal_transport", direction: "debit", amountCents: 15_000, description: null, occurredAt: null, estimated: false },
      { eventKind: "deal_recon", direction: "debit", amountCents: 60_000, description: null, occurredAt: null, estimated: false },
      { eventKind: "deal_sale_expense", direction: "debit", amountCents: 10_000, description: null, occurredAt: null, estimated: false },
      { eventKind: "deal_sale_proceeds", direction: "credit", amountCents: 1_000_000, description: null, occurredAt: null, estimated: false },
      { eventKind: "deal_adjustment", direction: "debit", amountCents: 5_000, description: null, occurredAt: null, estimated: false },
    ]);

    expect(totals.acquisitionCents).toBe(805_000);
    expect(totals.reconHoldingCents).toBe(70_000);
    expect(totals.saleProceedsCents).toBe(1_000_000);
    expect(totals.realizedGrossCents).toBe(195_000);
    expect(totals.realizedNetCents).toBe(1_000_000 - 805_000 - 70_000 - 5_000);
  });
});

describe("deal settlement validators", () => {
  it("rejects deal event kinds on the manual finance-event schema", () => {
    const result = createFinanceEventSchema.safeParse({
      eventKind: "deal_sale_proceeds",
      direction: "credit",
      biller: "manual",
      amountCents: 100,
      occurredAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("derives directions and rejects a wrong explicit direction", () => {
    const bad = createDealSettlementSchema.safeParse({
      dealKey: "VIN123-2026-07",
      legs: [{ eventKind: "deal_sale_proceeds", direction: "debit", amountCents: 100 }],
    });
    expect(bad.success).toBe(false);

    const adjustmentWithoutDirection = createDealSettlementSchema.safeParse({
      dealKey: "VIN123-2026-07",
      legs: [{ eventKind: "deal_adjustment", amountCents: 100 }],
    });
    expect(adjustmentWithoutDirection.success).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("deal settlement lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let settlements!: ReturnType<typeof dealSettlementService>;
  let finance!: ReturnType<typeof financeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deal-settlements-");
    db = createDb(tempDb.connectionString);
    settlements = dealSettlementService(db);
    finance = financeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(dealSettlements);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "DealerScope",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function honda(dealKey = "1HGCM82633A004352-2026-06") {
    return createDealSettlementSchema.parse({
      dealKey,
      vin: "1HGCM82633A004352",
      vehicleDescription: "2019 Honda Accord EX-L",
      soldAt: "2026-07-01T00:00:00.000Z",
      legs: [
        { eventKind: "deal_acquisition", amountCents: 750_000 },
        { eventKind: "deal_auction_fee", amountCents: 40_000 },
        { eventKind: "deal_recon", amountCents: 60_000 },
        { eventKind: "deal_sale_proceeds", amountCents: 1_000_000 },
      ],
    });
  }

  it("commits a draft into idempotent ledger legs with realized totals", async () => {
    const companyId = await makeCompany();

    const draft = await settlements.createDraft(companyId, honda());
    expect(draft.status).toBe("draft");
    expect(draft.revision).toBe(1);
    expect(draft.realizedNetCents).toBeNull();

    const committed = await settlements.commit(draft.id, { committedByUserId: "board" });
    expect(committed.status).toBe("committed");
    expect(committed.acquisitionCents).toBe(790_000);
    expect(committed.reconHoldingCents).toBe(60_000);
    expect(committed.saleProceedsCents).toBe(1_000_000);
    expect(committed.realizedGrossCents).toBe(210_000);
    expect(committed.realizedNetCents).toBe(150_000);

    const legs = await settlements.listLegs(draft.id);
    expect(legs).toHaveLength(4);
    expect(legs.filter((leg) => leg.direction === "credit")).toHaveLength(1);
    expect(legs.every((leg) => leg.dealSettlementId === draft.id)).toBe(true);

    const summary = await finance.summary(companyId);
    expect(summary.creditCents).toBe(1_000_000);
    expect(summary.debitCents).toBe(850_000);

    await expect(settlements.commit(draft.id)).rejects.toThrow(/only drafts/i);
  });

  it("rejects a second active settlement for the same deal key", async () => {
    const companyId = await makeCompany();
    await settlements.createDraft(companyId, honda());
    await expect(settlements.createDraft(companyId, honda())).rejects.toThrow(/already exists/i);
  });

  it("reverses a committed settlement with mirrored legs and allows a corrected revision", async () => {
    const companyId = await makeCompany();
    const draft = await settlements.createDraft(companyId, honda());
    await settlements.commit(draft.id);

    const reversed = await settlements.reverse(draft.id, { reason: "Arbitration refund" });
    expect(reversed.status).toBe("reversed");

    const legs = await settlements.listLegs(draft.id);
    expect(legs).toHaveLength(8);
    const reversalLegs = legs.filter((leg) => leg.reversesFinanceEventId != null);
    expect(reversalLegs).toHaveLength(4);

    const summary = await finance.summary(companyId);
    expect(summary.netCents).toBe(0);

    const corrected = await settlements.createDraft(companyId, honda());
    expect(corrected.revision).toBe(2);
    const committed = await settlements.commit(corrected.id);
    expect(committed.status).toBe("committed");

    await expect(settlements.reverse(draft.id, { reason: "again" })).rejects.toThrow(/only committed/i);
  });

  it("refuses to edit a settlement once committed", async () => {
    const companyId = await makeCompany();
    const draft = await settlements.createDraft(companyId, honda());
    await settlements.commit(draft.id);
    await expect(
      settlements.updateDraft(draft.id, { notes: "tweak" } as never),
    ).rejects.toThrow(/only draft/i);
  });
});
