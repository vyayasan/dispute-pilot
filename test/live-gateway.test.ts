import { describe, it, expect, vi } from "vitest";
import { LiveGateway } from "../src/gateway/live.js";
import { createConsoleApi } from "../src/console/api.js";

const raw = (over: Record<string, unknown> = {}) => ({ id: "dst_1", amount: 480, currency: "USD", reason: { original_code: "10.4" }, stage: "RFI", status: "REQUIRES_RESPONSE", due_at: "2026-10-14T00:00:00Z", ...over });
const facts = () => ({ deviceIpMatchesPriorUndisputed: 3, signedDelivery: true, unansweredSupportEmails: 0 });
const make = () => {
  const client = { listDisputes: vi.fn(async () => ({ items: [raw()] })), getDispute: vi.fn(async () => raw()), accept: vi.fn(async () => ({})),
    challenge: vi.fn(async () => ({})), uploadFile: vi.fn(async () => ({ file_id: "file_1" })) };
  return { client, gw: new LiveGateway({ client, factsFor: facts, actor: "reviewer" }) };
};
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");

describe("live gateway behind the console", () => {
  it("lists remote disputes through the async gateway", async () => {
    const { gw } = make();
    const handler = createConsoleApi({ key: "k".repeat(32), gateway: gw });
    const body: any = await (await handler(new Request("http://x/api/cases"))).json();
    expect(body.cases[0].dispute.id).toBe("dst_1");
    expect(body.cases[0].dispute.reasonCode).toBe("10.4");
  });
  it("uploads staged evidence only when a challenge is approved, then refers to it by file id", async () => {
    const { client, gw } = make();
    const handler = createConsoleApi({ key: "k".repeat(32), gateway: gw });
    await handler(new Request("http://x/api/cases"));
    const up = await handler(new Request("http://x/api/evidence", { method: "POST", body: JSON.stringify({ disputeId: "dst_1", name: "proof.jpg", kind: "jpg", base64: jpg }) }));
    expect(up.status).toBe(200);
    expect(client.uploadFile).not.toHaveBeenCalled();
    await gw.apply("dst_1", "CHALLENGE");
    expect(client.uploadFile).toHaveBeenCalledOnce();
    const call = client.challenge.mock.calls[0] as unknown[];
    expect(JSON.stringify(call[2])).toContain("file_1");
  });
  it("rejects evidence whose bytes do not match the declared type", async () => {
    const { gw } = make();
    const handler = createConsoleApi({ key: "k".repeat(32), gateway: gw });
    await handler(new Request("http://x/api/cases"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString("base64");
    const r = await handler(new Request("http://x/api/evidence", { method: "POST", body: JSON.stringify({ disputeId: "dst_1", name: "a.jpg", kind: "jpg", base64: png }) }));
    expect(r.status).toBe(415);
  });
  it("escalation is a handoff and never calls Airwallex", async () => {
    const { client, gw } = make();
    await gw.list();
    expect(await gw.apply("dst_1", "ESCALATE")).toContain("ESCALATED");
    expect(client.accept).not.toHaveBeenCalled(); expect(client.challenge).not.toHaveBeenCalled();
  });
});
