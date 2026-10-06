import { describe, expect, it } from "vitest";
import { issue } from "../../src/approval/approval.js";
import { createConsoleApi } from "../../src/console/api.js";
import type { Dispute } from "../../src/domain/types.js";
import { makeSim, type Gateway } from "../../src/sim/simGateway.js";

const KEY = "red-team-test-key-at-least-32-characters";
const LIVE: Dispute = {
  id: "dsp_demo_fraud", amount: 480, currency: "USD", reasonCode: "10.4",
  stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: "2026-12-01T00:00:00Z",
};
const post = (handler: (request: Request) => Promise<Response>, path: string, body: unknown, origin = "http://localhost:3000") =>
  handler(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  }));
const token = (d = LIVE) => issue(d, "CHALLENGE", ["evidence"], "2026-10-05.1", "reviewer", KEY, 60_000);

type TestGateway = Gateway & { callsValue: number };
function gatewayWithAmbiguousFailure(): TestGateway {
  const sim = makeSim();
  let calls = 0;
  return {
    list: () => sim.list(),
    get: (id) => sim.get(id),
    apply(id, action) {
      calls++;
      // Model a remote system that commits the action but whose response is lost.
      // Keep the local state unchanged so a retry remains otherwise valid.
      if (calls === 1) throw new Error("upstream timed out after commit");
      return sim.apply(id, action);
    },
    get callsValue() { return calls; },
  } as TestGateway;
}

describe("red team: console boundaries", () => {
  it("lets an unauthenticated cross-origin caller mint and use an approval", async () => {
    const handler = createConsoleApi({ key: KEY });
    const minted = await post(handler, "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" }, "http://attacker.example");
    expect(minted.status).toBe(200);
    const { approval } = await minted.json() as { approval: unknown };
    const executed = await post(handler, "/api/act", { approval }, "http://attacker.example");
    expect(executed.status).toBe(200);
  });

  it("refuses an approval when live bound state changes after issuance", async () => {
    const gateway = makeSim();
    const handler = createConsoleApi({ key: KEY, gateway });
    const approval = token(gateway.get(LIVE.id)!.dispute);
    gateway.get(LIVE.id)!.dispute.amount++;
    const response = await post(handler, "/api/act", { approval });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "amount changed" });
  });

  it("FIXED: consumes the approval before the gateway call, so an ambiguous failure cannot be blindly replayed", async () => {
    const gateway = gatewayWithAmbiguousFailure();
    const handler = createConsoleApi({ key: KEY, gateway });
    const approved = await post(handler, "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" });
    const { approval } = await approved.json() as { approval: unknown };
    const first = await post(handler, "/api/act", { approval });
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: expect.stringContaining("outcome unknown") });
    const second = await post(handler, "/api/act", { approval });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "approval already used" });
    expect(gateway.callsValue).toBe(1);
  });

  it("serial concurrent submissions allow only one successful execution in this single process", async () => {
    const handler = createConsoleApi({ key: KEY });
    const minted = await post(handler, "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" });
    const { approval } = await minted.json() as { approval: unknown };
    const responses = await Promise.all([
      post(handler, "/api/act", { approval }), post(handler, "/api/act", { approval }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe("red team: console reset and browser boundary", () => {
  it("accepts foreign Origin on approval and execution handlers", async () => {
    const handler = createConsoleApi({ key: KEY });
    const minted = await post(handler, "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" }, "https://untrusted.example");
    expect(minted.status).toBe(200);
    const { approval } = await minted.json() as { approval: unknown };
    expect((await post(handler, "/api/act", { approval }, "https://untrusted.example")).status).toBe(200);
  });

  it("FIXED: a consumed approval stays dead after demo reset", async () => {
    const handler = createConsoleApi({ key: KEY });
    const minted = await post(handler, "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" });
    const { approval } = await minted.json() as { approval: unknown };
    expect((await post(handler, "/api/act", { approval })).status).toBe(200);
    expect((await post(handler, "/api/reset-demo", {})).status).toBe(200);
    expect((await post(handler, "/api/act", { approval })).status).toBe(409);
  });
});

describe("red team: hardened console configuration", () => {
  const hardened = () => createConsoleApi({ key: KEY, sessionToken: "tok", allowedOrigins: ["http://localhost:3000"] });
  const postH = (h: (r: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string>) =>
    h(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  it("refuses a foreign Origin", async () => expect((await postH(hardened(), "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" }, { origin: "http://attacker.example", "x-console-token": "tok" })).status).toBe(403));
  it("refuses a missing or wrong token (mint and reset)", async () => {
    const h = hardened();
    for (const t of [{} as Record<string, string>, { "x-console-token": "nope" }]) {
      expect((await postH(h, "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" }, t)).status).toBe(403);
      expect((await postH(h, "/api/reset-demo", {}, t)).status).toBe(403);
    }
  });
  it("accepts the right token from the right origin", async () => expect((await postH(hardened(), "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" }, { origin: "http://localhost:3000", "x-console-token": "tok" })).status).toBe(200));
});

describe("console behaviour: override, one shot, audit", () => {
  const act = async (h: (r: Request) => Promise<Response>, id: string, action: string) => {
    const { approval } = await (await post(h, "/api/approve", { disputeId: id, action })).json() as any;
    return post(h, "/api/act", { approval });
  };
  it("flags an override against the recommendation in timeline and audit", async () => {
    const h = createConsoleApi({ key: KEY });
    const r = await (await act(h, "dsp_demo_small", "CHALLENGE")).json() as any;
    expect(r.case.timeline.some((t: any) => t.title === "Override")).toBe(true);
    const all = await (await h(new Request("http://localhost/api/cases"))).json() as any;
    expect(all.audit.some((a: any) => a.kind === "override")).toBe(true);
  });
  it("blocks a second CHALLENGE after the issuer rejected the evidence", async () => {
    const h = createConsoleApi({ key: KEY });
    await act(h, LIVE.id, "CHALLENGE");
    const again = await post(h, "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" });
    expect(again.status).toBe(409);
    const esc = await act(h, LIVE.id, "ESCALATE");
    expect(esc.status).toBe(200);
  });
  it("keeps a verifiable audit chain", async () => {
    const h = createConsoleApi({ key: KEY });
    await act(h, LIVE.id, "CHALLENGE"); await post(h, "/api/reset-demo", {});
    const all = await (await h(new Request("http://localhost/api/cases"))).json() as any;
    const { verifyChain } = await import("../../src/audit/audit.js");
    expect(verifyChain(all.audit)).toEqual({ ok: true });
  });
});

describe("rationale and rejection reason", () => {
  it("binds the agent rationale into the signed approval (editing it breaks the signature)", async () => {
    const h = createConsoleApi({ key: KEY });
    const { approval } = await (await post(h, "/api/approve", { disputeId: LIVE.id, action: "CHALLENGE" })).json() as any;
    expect(approval.rationale).toContain("Agent recommends");
    const r = await post(h, "/api/act", { approval: { ...approval, rationale: "trust me" } });
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ error: "bad signature" });
  });
  it("refuses a rejection without a reason and records one with a reason", async () => {
    const h = createConsoleApi({ key: KEY });
    expect((await post(h, "/api/reject", { disputeId: LIVE.id })).status).toBe(400);
    expect((await post(h, "/api/reject", { disputeId: LIVE.id, reason: "   " })).status).toBe(400);
    const ok = await post(h, "/api/reject", { disputeId: LIVE.id, reason: "customer called, resolved offline" });
    expect(ok.status).toBe(200);
    const all = await (await h(new Request("http://localhost/api/cases"))).json() as any;
    expect(all.audit.some((a: any) => a.kind === "recommendation_rejected" && a.detail.reason.includes("offline"))).toBe(true);
  });
});
