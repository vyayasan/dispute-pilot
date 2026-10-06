import { describe, it, expect } from "vitest";
import { issue } from "../src/approval/approval.js";
import type { Dispute } from "../src/domain/types.js";
import { createConsoleApi } from "../src/console/api.js";
import { makeSim } from "../src/sim/simGateway.js";

const KEY = "test-signing-key-that-is-at-least-32-chars";
const post = (handler: (request: Request) => Promise<Response>, path: string, body: unknown) => handler(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const approvedToken = (dispute: Dispute) => issue(dispute, "CHALLENGE", ["evidence"], "2026-10-05.1", "reviewer", KEY, 60_000);

describe("console /api/act boundary", () => {
  it("refuses a tampered approval token", async () => {
    const handler = createConsoleApi({ key: KEY });
    const approval = { ...approvedToken({ id: "dsp_demo_fraud", amount: 480, currency: "USD", reasonCode: "10.4", stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: "2026-10-20T00:00:00Z" }), amount: 1 };
    const response = await post(handler, "/api/act", { approval });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "bad signature" });
  });

  it("refuses replay of an already executed approval", async () => {
    const handler = createConsoleApi({ key: KEY });
    const approved = await post(handler, "/api/approve", { disputeId: "dsp_demo_fraud", action: "CHALLENGE" });
    const approval = (await approved.json() as { approval: unknown }).approval;
    expect((await post(handler, "/api/act", { approval })).status).toBe(200);
    const replay = await post(handler, "/api/act", { approval });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: "approval already used" });
  });

  it("refuses a signed action that is illegal in the current live state", async () => {
    const gateway = makeSim();
    const live = gateway.get("dsp_demo_fraud")!.dispute;
    live.status = "CHALLENGED";
    const handler = createConsoleApi({ key: KEY, gateway });
    const approval = approvedToken(live);
    const response = await post(handler, "/api/act", { approval });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "action not legal in live state" });
  });
});
