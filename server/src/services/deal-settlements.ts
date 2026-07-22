import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { dealSettlements, financeEvents, goals, issues, projects } from "@paperclipai/db";
import type {
  CreateDealSettlement,
  DealSettlement,
  DealSettlementLeg,
  DealSettlementLegInput,
  UpdateDealSettlementDraft,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type DealSettlementRow = typeof dealSettlements.$inferSelect;

const DEAL_LEG_BILLER = "deal_settlement";

const ACQUISITION_KINDS = new Set(["deal_acquisition", "deal_auction_fee", "deal_transport", "deal_title_reg"]);
const RECON_HOLDING_KINDS = new Set(["deal_recon", "deal_holding", "deal_sale_expense"]);

function legDirection(leg: DealSettlementLegInput): "debit" | "credit" {
  if (leg.eventKind === "deal_adjustment") return leg.direction ?? "debit";
  return leg.eventKind === "deal_sale_proceeds" ? "credit" : "debit";
}

function normalizeLegs(legs: DealSettlementLegInput[]): DealSettlementLeg[] {
  return legs.map((leg) => ({
    eventKind: leg.eventKind,
    direction: legDirection(leg),
    amountCents: leg.amountCents,
    description: leg.description ?? null,
    occurredAt: leg.occurredAt ?? null,
    estimated: leg.estimated ?? false,
  }));
}

export function computeSettlementTotals(legs: DealSettlementLeg[]) {
  let acquisitionCents = 0;
  let reconHoldingCents = 0;
  let saleProceedsCents = 0;
  let totalDebits = 0;
  let totalCredits = 0;

  for (const leg of legs) {
    if (leg.direction === "credit") totalCredits += leg.amountCents;
    else totalDebits += leg.amountCents;

    if (ACQUISITION_KINDS.has(leg.eventKind) && leg.direction === "debit") {
      acquisitionCents += leg.amountCents;
    } else if (RECON_HOLDING_KINDS.has(leg.eventKind) && leg.direction === "debit") {
      reconHoldingCents += leg.amountCents;
    } else if (leg.eventKind === "deal_sale_proceeds") {
      saleProceedsCents += leg.amountCents;
    }
  }

  return {
    acquisitionCents,
    reconHoldingCents,
    saleProceedsCents,
    realizedGrossCents: saleProceedsCents - acquisitionCents,
    realizedNetCents: totalCredits - totalDebits,
  };
}

function toDealSettlement(row: DealSettlementRow): DealSettlement {
  return {
    id: row.id,
    companyId: row.companyId,
    dealKey: row.dealKey,
    revision: row.revision,
    vin: row.vin ?? null,
    vehicleDescription: row.vehicleDescription ?? null,
    soldAt: row.soldAt ?? null,
    originIssueId: row.originIssueId ?? null,
    originGoalId: row.originGoalId ?? null,
    originProjectId: row.originProjectId ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    attributionConfidence: row.attributionConfidence as DealSettlement["attributionConfidence"],
    status: row.status as DealSettlement["status"],
    currency: row.currency,
    legsJson: (row.legsJson as unknown as DealSettlementLeg[]) ?? [],
    acquisitionCents: row.acquisitionCents ?? null,
    reconHoldingCents: row.reconHoldingCents ?? null,
    saleProceedsCents: row.saleProceedsCents ?? null,
    realizedGrossCents: row.realizedGrossCents ?? null,
    realizedNetCents: row.realizedNetCents ?? null,
    committedByUserId: row.committedByUserId ?? null,
    committedAt: row.committedAt ?? null,
    reversedAt: row.reversedAt ?? null,
    reversalReason: row.reversalReason ?? null,
    notes: row.notes ?? null,
    metadataJson: (row.metadataJson as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertOriginBelongsToCompany(
  db: Db,
  data: Pick<CreateDealSettlement, "originIssueId" | "originGoalId" | "originProjectId">,
  companyId: string,
) {
  const checks: Array<[typeof issues | typeof goals | typeof projects, string | null | undefined, string]> = [
    [issues, data.originIssueId, "Origin issue"],
    [goals, data.originGoalId, "Origin goal"],
    [projects, data.originProjectId, "Origin project"],
  ];
  for (const [table, id, label] of checks) {
    if (!id) continue;
    const row = await db
      .select({ companyId: table.companyId })
      .from(table)
      .where(eq(table.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound(`${label} not found`);
    if (row.companyId !== companyId) throw unprocessable(`${label} does not belong to company`);
  }
}

export function dealSettlementService(db: Db) {
  async function getRow(id: string): Promise<DealSettlementRow | null> {
    return db
      .select()
      .from(dealSettlements)
      .where(eq(dealSettlements.id, id))
      .then((rows) => rows[0] ?? null);
  }

  return {
    createDraft: async (
      companyId: string,
      data: CreateDealSettlement,
      options: { createdByAgentId?: string | null } = {},
    ) => {
      await assertOriginBelongsToCompany(db, data, companyId);

      const active = await db
        .select({ id: dealSettlements.id, revision: dealSettlements.revision })
        .from(dealSettlements)
        .where(
          and(
            eq(dealSettlements.companyId, companyId),
            eq(dealSettlements.dealKey, data.dealKey),
            ne(dealSettlements.status, "reversed"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (active) {
        throw conflict(`An active settlement already exists for deal '${data.dealKey}'`);
      }

      const [{ maxRevision }] = await db
        .select({ maxRevision: sql<number>`coalesce(max(${dealSettlements.revision}), 0)::int` })
        .from(dealSettlements)
        .where(and(eq(dealSettlements.companyId, companyId), eq(dealSettlements.dealKey, data.dealKey)));

      const row = await db
        .insert(dealSettlements)
        .values({
          companyId,
          dealKey: data.dealKey,
          revision: (maxRevision ?? 0) + 1,
          vin: data.vin ?? null,
          vehicleDescription: data.vehicleDescription ?? null,
          soldAt: data.soldAt ? new Date(data.soldAt) : null,
          originIssueId: data.originIssueId ?? null,
          originGoalId: data.originGoalId ?? null,
          originProjectId: data.originProjectId ?? null,
          createdByAgentId: options.createdByAgentId ?? null,
          attributionConfidence: data.attributionConfidence,
          currency: data.currency,
          legsJson: normalizeLegs(data.legs) as unknown as Record<string, unknown>[],
          notes: data.notes ?? null,
          metadataJson: data.metadataJson ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      return toDealSettlement(row);
    },

    updateDraft: async (id: string, patch: UpdateDealSettlementDraft) => {
      const existing = await getRow(id);
      if (!existing) throw notFound("Deal settlement not found");
      if (existing.status !== "draft") {
        throw conflict("Only draft settlements can be edited; use a reversal and a new settlement instead");
      }
      await assertOriginBelongsToCompany(db, patch, existing.companyId);

      const row = await db
        .update(dealSettlements)
        .set({
          ...(patch.vin !== undefined ? { vin: patch.vin } : {}),
          ...(patch.vehicleDescription !== undefined ? { vehicleDescription: patch.vehicleDescription } : {}),
          ...(patch.soldAt !== undefined ? { soldAt: patch.soldAt ? new Date(patch.soldAt) : null } : {}),
          ...(patch.originIssueId !== undefined ? { originIssueId: patch.originIssueId } : {}),
          ...(patch.originGoalId !== undefined ? { originGoalId: patch.originGoalId } : {}),
          ...(patch.originProjectId !== undefined ? { originProjectId: patch.originProjectId } : {}),
          ...(patch.attributionConfidence ? { attributionConfidence: patch.attributionConfidence } : {}),
          ...(patch.currency ? { currency: patch.currency } : {}),
          ...(patch.legs
            ? { legsJson: normalizeLegs(patch.legs) as unknown as Record<string, unknown>[] }
            : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
          ...(patch.metadataJson !== undefined ? { metadataJson: patch.metadataJson } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(dealSettlements.id, id), eq(dealSettlements.status, "draft")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw conflict("Settlement is no longer a draft");
      return toDealSettlement(row);
    },

    commit: async (id: string, options: { committedByUserId?: string | null } = {}) => {
      return db.transaction(async (tx) => {
        const settlement = await tx
          .select()
          .from(dealSettlements)
          .where(eq(dealSettlements.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!settlement) throw notFound("Deal settlement not found");
        if (settlement.status !== "draft") {
          throw conflict(`Settlement is ${settlement.status}; only drafts can be committed`);
        }

        const otherCommitted = await tx
          .select({ id: dealSettlements.id })
          .from(dealSettlements)
          .where(
            and(
              eq(dealSettlements.companyId, settlement.companyId),
              eq(dealSettlements.dealKey, settlement.dealKey),
              eq(dealSettlements.status, "committed"),
              ne(dealSettlements.id, settlement.id),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (otherCommitted) {
          throw conflict(`Deal '${settlement.dealKey}' already has a committed settlement`);
        }

        const legs = (settlement.legsJson as unknown as DealSettlementLeg[]) ?? [];
        if (legs.length === 0) throw unprocessable("Settlement has no legs to commit");
        const totals = computeSettlementTotals(legs);
        const now = new Date();

        await tx.insert(financeEvents).values(
          legs.map((leg) => ({
            companyId: settlement.companyId,
            agentId: settlement.createdByAgentId ?? null,
            issueId: settlement.originIssueId ?? null,
            goalId: settlement.originGoalId ?? null,
            projectId: settlement.originProjectId ?? null,
            dealSettlementId: settlement.id,
            eventKind: leg.eventKind,
            direction: leg.direction,
            biller: DEAL_LEG_BILLER,
            description: leg.description ?? null,
            amountCents: leg.amountCents,
            currency: settlement.currency,
            estimated: leg.estimated,
            metadataJson: {
              settlementId: settlement.id,
              dealKey: settlement.dealKey,
              vin: settlement.vin,
            },
            occurredAt: leg.occurredAt ? new Date(leg.occurredAt) : settlement.soldAt ?? now,
          })),
        );

        const committed = await tx
          .update(dealSettlements)
          .set({
            status: "committed",
            ...totals,
            committedByUserId: options.committedByUserId ?? null,
            committedAt: now,
            updatedAt: now,
          })
          .where(and(eq(dealSettlements.id, settlement.id), eq(dealSettlements.status, "draft")))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!committed) throw conflict("Settlement was modified concurrently");
        return toDealSettlement(committed);
      });
    },

    reverse: async (id: string, options: { reason: string; reversedByUserId?: string | null }) => {
      return db.transaction(async (tx) => {
        const settlement = await tx
          .select()
          .from(dealSettlements)
          .where(eq(dealSettlements.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!settlement) throw notFound("Deal settlement not found");
        if (settlement.status !== "committed") {
          throw conflict(`Settlement is ${settlement.status}; only committed settlements can be reversed`);
        }

        const originalLegs = await tx
          .select()
          .from(financeEvents)
          .where(
            and(
              eq(financeEvents.dealSettlementId, settlement.id),
              isNull(financeEvents.reversesFinanceEventId),
            ),
          );

        const now = new Date();
        if (originalLegs.length > 0) {
          await tx.insert(financeEvents).values(
            originalLegs.map((leg) => ({
              companyId: leg.companyId,
              agentId: leg.agentId,
              issueId: leg.issueId,
              goalId: leg.goalId,
              projectId: leg.projectId,
              dealSettlementId: settlement.id,
              reversesFinanceEventId: leg.id,
              eventKind: leg.eventKind,
              direction: leg.direction === "credit" ? "debit" : "credit",
              biller: DEAL_LEG_BILLER,
              description: `Reversal: ${options.reason}`,
              amountCents: leg.amountCents,
              currency: leg.currency,
              estimated: leg.estimated,
              metadataJson: {
                settlementId: settlement.id,
                dealKey: settlement.dealKey,
                vin: settlement.vin,
                reversalOf: leg.id,
              },
              occurredAt: now,
            })),
          );
        }

        const reversed = await tx
          .update(dealSettlements)
          .set({
            status: "reversed",
            reversedAt: now,
            reversalReason: options.reason,
            updatedAt: now,
          })
          .where(and(eq(dealSettlements.id, settlement.id), eq(dealSettlements.status, "committed")))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reversed) throw conflict("Settlement was modified concurrently");
        return toDealSettlement(reversed);
      });
    },

    getById: async (id: string) => {
      const row = await getRow(id);
      return row ? toDealSettlement(row) : null;
    },

    listForCompany: async (
      companyId: string,
      options: { statuses?: DealSettlement["status"][]; limit?: number } = {},
    ) => {
      const conditions = [eq(dealSettlements.companyId, companyId)];
      if (options.statuses && options.statuses.length > 0) {
        conditions.push(inArray(dealSettlements.status, options.statuses));
      }
      const rows = await db
        .select()
        .from(dealSettlements)
        .where(and(...conditions))
        .orderBy(desc(dealSettlements.createdAt))
        .limit(options.limit ?? 100);
      return rows.map(toDealSettlement);
    },

    listLegs: async (settlementId: string) => {
      return db
        .select()
        .from(financeEvents)
        .where(eq(financeEvents.dealSettlementId, settlementId))
        .orderBy(financeEvents.createdAt);
    },
  };
}
