import { z } from "zod";
import {
  DEAL_ATTRIBUTION_CONFIDENCES,
  DEAL_EVENT_KINDS,
  FINANCE_DIRECTIONS,
} from "../constants.js";

export const dealSettlementLegSchema = z
  .object({
    eventKind: z.enum(DEAL_EVENT_KINDS),
    // Direction is derived from the kind; only deal_adjustment may specify it.
    direction: z.enum(FINANCE_DIRECTIONS).optional(),
    amountCents: z.number().int().positive(),
    description: z.string().max(500).optional().nullable(),
    occurredAt: z.string().datetime().optional().nullable(),
    estimated: z.boolean().optional().default(false),
  })
  .superRefine((leg, ctx) => {
    if (leg.eventKind === "deal_adjustment") {
      if (!leg.direction) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "deal_adjustment legs must specify a direction",
          path: ["direction"],
        });
      }
    } else if (leg.direction) {
      const expected = leg.eventKind === "deal_sale_proceeds" ? "credit" : "debit";
      if (leg.direction !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `direction for ${leg.eventKind} legs is always ${expected}; omit it or pass ${expected}`,
          path: ["direction"],
        });
      }
    }
  });

export const createDealSettlementSchema = z.object({
  dealKey: z.string().min(1).max(200),
  vin: z.string().min(1).max(32).optional().nullable(),
  vehicleDescription: z.string().max(500).optional().nullable(),
  soldAt: z.string().datetime().optional().nullable(),
  originIssueId: z.string().uuid().optional().nullable(),
  originGoalId: z.string().uuid().optional().nullable(),
  originProjectId: z.string().uuid().optional().nullable(),
  attributionConfidence: z.enum(DEAL_ATTRIBUTION_CONFIDENCES).optional().default("exact"),
  currency: z.string().length(3).optional().default("USD"),
  legs: z.array(dealSettlementLegSchema).min(1).max(100),
  notes: z.string().max(2000).optional().nullable(),
  metadataJson: z.record(z.string(), z.unknown()).optional().nullable(),
}).transform((value) => ({
  ...value,
  currency: value.currency.toUpperCase(),
}));

export const updateDealSettlementDraftSchema = z.object({
  vin: z.string().min(1).max(32).optional().nullable(),
  vehicleDescription: z.string().max(500).optional().nullable(),
  soldAt: z.string().datetime().optional().nullable(),
  originIssueId: z.string().uuid().optional().nullable(),
  originGoalId: z.string().uuid().optional().nullable(),
  originProjectId: z.string().uuid().optional().nullable(),
  attributionConfidence: z.enum(DEAL_ATTRIBUTION_CONFIDENCES).optional(),
  currency: z.string().length(3).optional(),
  legs: z.array(dealSettlementLegSchema).min(1).max(100).optional(),
  notes: z.string().max(2000).optional().nullable(),
  metadataJson: z.record(z.string(), z.unknown()).optional().nullable(),
}).transform((value) => ({
  ...value,
  currency: value.currency ? value.currency.toUpperCase() : undefined,
}));

export const reverseDealSettlementSchema = z.object({
  reason: z.string().min(1).max(500),
});

export type DealSettlementLegInput = z.infer<typeof dealSettlementLegSchema>;
export type CreateDealSettlement = z.infer<typeof createDealSettlementSchema>;
export type UpdateDealSettlementDraft = z.infer<typeof updateDealSettlementDraftSchema>;
export type ReverseDealSettlement = z.infer<typeof reverseDealSettlementSchema>;
