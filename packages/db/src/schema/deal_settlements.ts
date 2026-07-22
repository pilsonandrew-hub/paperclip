import { pgTable, uuid, text, timestamp, integer, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";

export const dealSettlements = pgTable(
  "deal_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    dealKey: text("deal_key").notNull(),
    revision: integer("revision").notNull().default(1),
    vin: text("vin"),
    vehicleDescription: text("vehicle_description"),
    soldAt: timestamp("sold_at", { withTimezone: true }),
    originIssueId: uuid("origin_issue_id").references(() => issues.id),
    originGoalId: uuid("origin_goal_id").references(() => goals.id),
    originProjectId: uuid("origin_project_id").references(() => projects.id),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    attributionConfidence: text("attribution_confidence").notNull().default("exact"),
    status: text("status").notNull().default("draft"),
    currency: text("currency").notNull().default("USD"),
    legsJson: jsonb("legs_json").$type<Record<string, unknown>[]>().notNull(),
    acquisitionCents: integer("acquisition_cents"),
    reconHoldingCents: integer("recon_holding_cents"),
    saleProceedsCents: integer("sale_proceeds_cents"),
    realizedGrossCents: integer("realized_gross_cents"),
    realizedNetCents: integer("realized_net_cents"),
    committedByUserId: text("committed_by_user_id"),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversalReason: text("reversal_reason"),
    notes: text("notes"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDealKeyRevisionUnique: uniqueIndex("deal_settlements_company_deal_key_revision_unique").on(
      table.companyId,
      table.dealKey,
      table.revision,
    ),
    companyStatusIdx: index("deal_settlements_company_status_idx").on(table.companyId, table.status),
    companySoldAtIdx: index("deal_settlements_company_sold_at_idx").on(table.companyId, table.soldAt),
    companyOriginIssueIdx: index("deal_settlements_company_origin_issue_idx").on(
      table.companyId,
      table.originIssueId,
    ),
    companyOriginGoalIdx: index("deal_settlements_company_origin_goal_idx").on(
      table.companyId,
      table.originGoalId,
    ),
  }),
);
