import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createDealSettlementSchema,
  reverseDealSettlementSchema,
  updateDealSettlementDraftSchema,
  DEAL_SETTLEMENT_STATUSES,
  type DealSettlementStatus,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { dealSettlementService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { parseCostLimit } from "./costs.js";

function parseStatuses(query: Record<string, unknown>): DealSettlementStatus[] | undefined {
  const raw = query.status;
  if (raw == null || raw === "") return undefined;
  const values = (Array.isArray(raw) ? raw : String(raw).split(",")).map((value) => String(value).trim());
  for (const value of values) {
    if (!(DEAL_SETTLEMENT_STATUSES as readonly string[]).includes(value)) {
      throw badRequest(`invalid 'status' value: ${value}`);
    }
  }
  return values as DealSettlementStatus[];
}

export function dealSettlementRoutes(db: Db) {
  const router = Router();
  const settlements = dealSettlementService(db);

  async function getScoped(req: { params: Record<string, unknown> }, companyId: string) {
    const settlement = await settlements.getById(req.params.settlementId as string);
    if (!settlement || settlement.companyId !== companyId) {
      throw notFound("Deal settlement not found");
    }
    return settlement;
  }

  router.post(
    "/companies/:companyId/deal-settlements",
    validate(createDealSettlementSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const settlement = await settlements.createDraft(companyId, req.body, {
        createdByAgentId: req.actor.type === "agent" ? req.actor.agentId : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "deal_settlement.drafted",
        entityType: "deal_settlement",
        entityId: settlement.id,
        details: { dealKey: settlement.dealKey, legCount: settlement.legsJson.length },
      });

      res.status(201).json(settlement);
    },
  );

  router.get("/companies/:companyId/deal-settlements", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await settlements.listForCompany(companyId, {
      statuses: parseStatuses(req.query),
      limit: parseCostLimit(req.query),
    });
    res.json(rows);
  });

  router.get("/companies/:companyId/deal-settlements/:settlementId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const settlement = await getScoped(req, companyId);
    const legs = await settlements.listLegs(settlement.id);
    res.json({ ...settlement, ledgerLegs: legs });
  });

  router.patch(
    "/companies/:companyId/deal-settlements/:settlementId",
    validate(updateDealSettlementDraftSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const existing = await getScoped(req, companyId);

      const actor = getActorInfo(req);
      const settlement = await settlements.updateDraft(existing.id, req.body);

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "deal_settlement.draft_updated",
        entityType: "deal_settlement",
        entityId: settlement.id,
        details: { dealKey: settlement.dealKey },
      });

      res.json(settlement);
    },
  );

  router.post("/companies/:companyId/deal-settlements/:settlementId/commit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const existing = await getScoped(req, companyId);

    const actor = getActorInfo(req);
    const settlement = await settlements.commit(existing.id, {
      committedByUserId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "deal_settlement.committed",
      entityType: "deal_settlement",
      entityId: settlement.id,
      details: {
        dealKey: settlement.dealKey,
        realizedNetCents: settlement.realizedNetCents,
        realizedGrossCents: settlement.realizedGrossCents,
      },
    });

    res.json(settlement);
  });

  router.post(
    "/companies/:companyId/deal-settlements/:settlementId/reverse",
    validate(reverseDealSettlementSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const existing = await getScoped(req, companyId);

      const actor = getActorInfo(req);
      const settlement = await settlements.reverse(existing.id, {
        reason: req.body.reason,
        reversedByUserId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "deal_settlement.reversed",
        entityType: "deal_settlement",
        entityId: settlement.id,
        details: { dealKey: settlement.dealKey, reason: req.body.reason },
      });

      res.json(settlement);
    },
  );

  return router;
}
