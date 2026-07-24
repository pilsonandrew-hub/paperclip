import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentConfigRevisions,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat run config revision stamp", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-config-revision-stamp-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
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
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("stamps the live config revision on a run when it is claimed", async () => {
    const { companyId, agentId } = await seedAgent();

    const olderRevisionId = randomUUID();
    const currentRevisionId = randomUUID();
    await db.insert(agentConfigRevisions).values({
      id: olderRevisionId,
      companyId,
      agentId,
      changedKeys: ["adapterConfig"],
      beforeConfig: { model: "gpt-4" },
      afterConfig: { model: "gpt-5" },
      createdAt: new Date("2026-06-01T00:00:00Z"),
    });
    await db.insert(agentConfigRevisions).values({
      id: currentRevisionId,
      companyId,
      agentId,
      changedKeys: ["budgetMonthlyCents"],
      beforeConfig: { budgetMonthlyCents: 1000 },
      afterConfig: { budgetMonthlyCents: 5000 },
      createdAt: new Date("2026-06-15T00:00:00Z"),
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    // The newest revision at claim time wins, not the first one recorded.
    expect(finished?.agentConfigRevisionId).toBe(currentRevisionId);
  });

  it("leaves the stamp null for an agent with no recorded revisions", async () => {
    const { agentId } = await seedAgent();

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);

    expect(finished?.status).toBe("succeeded");
    expect(finished?.agentConfigRevisionId).toBeNull();
  });
});
