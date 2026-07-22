CREATE TABLE "deal_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"deal_key" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"vin" text,
	"vehicle_description" text,
	"sold_at" timestamp with time zone,
	"origin_issue_id" uuid,
	"origin_goal_id" uuid,
	"origin_project_id" uuid,
	"created_by_agent_id" uuid,
	"attribution_confidence" text DEFAULT 'exact' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"legs_json" jsonb NOT NULL,
	"acquisition_cents" integer,
	"recon_holding_cents" integer,
	"sale_proceeds_cents" integer,
	"realized_gross_cents" integer,
	"realized_net_cents" integer,
	"committed_by_user_id" text,
	"committed_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"notes" text,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_events" ADD COLUMN "deal_settlement_id" uuid;--> statement-breakpoint
ALTER TABLE "finance_events" ADD COLUMN "reverses_finance_event_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_settlements" ADD CONSTRAINT "deal_settlements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_settlements" ADD CONSTRAINT "deal_settlements_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_settlements" ADD CONSTRAINT "deal_settlements_origin_goal_id_goals_id_fk" FOREIGN KEY ("origin_goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_settlements" ADD CONSTRAINT "deal_settlements_origin_project_id_projects_id_fk" FOREIGN KEY ("origin_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_settlements" ADD CONSTRAINT "deal_settlements_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deal_settlements_company_deal_key_revision_unique" ON "deal_settlements" USING btree ("company_id","deal_key","revision");--> statement-breakpoint
CREATE INDEX "deal_settlements_company_status_idx" ON "deal_settlements" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "deal_settlements_company_sold_at_idx" ON "deal_settlements" USING btree ("company_id","sold_at");--> statement-breakpoint
CREATE INDEX "deal_settlements_company_origin_issue_idx" ON "deal_settlements" USING btree ("company_id","origin_issue_id");--> statement-breakpoint
CREATE INDEX "deal_settlements_company_origin_goal_idx" ON "deal_settlements" USING btree ("company_id","origin_goal_id");--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_deal_settlement_id_deal_settlements_id_fk" FOREIGN KEY ("deal_settlement_id") REFERENCES "public"."deal_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_reverses_finance_event_id_finance_events_id_fk" FOREIGN KEY ("reverses_finance_event_id") REFERENCES "public"."finance_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_events_company_deal_settlement_idx" ON "finance_events" USING btree ("company_id","deal_settlement_id");