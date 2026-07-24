import { describe, expect, it } from "vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  agents,
  agentConfigRevisions,
  companies,
  costEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { agentService } from "../services/agents.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent config revision outcome attribution", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-config-revision-outcomes-");
    db = createDb(tempDb.connectionString);
    svc = agentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "DealerScope",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Appraiser",
      role: "analyst",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function addRun(
    companyId: string,
    agentId: string,
    revisionId: string | null,
    status: string,
    startedAt: Date,
    costCents?: number,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      agentConfigRevisionId: revisionId,
      status,
      startedAt,
      finishedAt: startedAt,
    });
    if (costCents != null) {
      await db.insert(costEvents).values({
        companyId,
        agentId,
        heartbeatRunId: runId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
        costCents,
        occurredAt: startedAt,
      });
    }
    return runId;
  }

  it("groups runs and costs by the config revision they executed under", async () => {
    const { companyId, agentId } = await seedAgent();

    const revisionId = randomUUID();
    await db.insert(agentConfigRevisions).values({
      id: revisionId,
      companyId,
      agentId,
      changedKeys: ["adapterConfig"],
      beforeConfig: { model: "gpt-4" },
      afterConfig: { model: "gpt-5" },
    });

    // Two runs under the original config, then three under the new revision.
    await addRun(companyId, agentId, null, "succeeded", new Date("2026-06-01T00:00:00Z"), 100);
    await addRun(companyId, agentId, null, "failed", new Date("2026-06-02T00:00:00Z"), 50);
    await addRun(companyId, agentId, revisionId, "succeeded", new Date("2026-06-10T00:00:00Z"), 200);
    await addRun(companyId, agentId, revisionId, "succeeded", new Date("2026-06-11T00:00:00Z"), 300);
    await addRun(companyId, agentId, revisionId, "timed_out", new Date("2026-06-12T00:00:00Z"));

    const outcomes = await svc.listConfigRevisionOutcomes(agentId);
    expect(outcomes).toHaveLength(2);

    // Most recent epoch first.
    const [current, baseline] = outcomes;
    expect(current.agentConfigRevisionId).toBe(revisionId);
    expect(current.runCount).toBe(3);
    expect(current.succeededCount).toBe(2);
    expect(current.failedCount).toBe(1);
    expect(Number(current.costCents)).toBe(500);

    expect(baseline.agentConfigRevisionId).toBeNull();
    expect(baseline.runCount).toBe(2);
    expect(baseline.succeededCount).toBe(1);
    expect(baseline.failedCount).toBe(1);
    expect(Number(baseline.costCents)).toBe(150);
  });

  it("excludes runs that never started and does not double-count multi-cost runs", async () => {
    const { companyId, agentId } = await seedAgent();

    const startedRunId = await addRun(
      companyId,
      agentId,
      null,
      "succeeded",
      new Date("2026-06-01T00:00:00Z"),
      100,
    );
    // A second cost event on the same run must not inflate the run count.
    await db.insert(costEvents).values({
      companyId,
      agentId,
      heartbeatRunId: startedRunId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-5",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      costCents: 25,
      occurredAt: new Date("2026-06-01T01:00:00Z"),
    });

    // Queued-but-never-started run produced no outcome to attribute.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "queued",
    });

    const outcomes = await svc.listConfigRevisionOutcomes(agentId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].runCount).toBe(1);
    expect(Number(outcomes[0].costCents)).toBe(125);
  });
});
