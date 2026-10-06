import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookVerifier, isDisputeEvent } from "../src/gateway/webhook.js";
import { AirwallexClient } from "../src/gateway/airwallex.js";

const sign = (secret: string, ts: string, body: string) => createHmac("sha256", secret).update(ts + body).digest("hex");
describe("webhook verification", () => {
  const NOW = 1_800_000_000_000, ts = String(NOW), body = JSON.stringify({ id: "evt_1", name: "payment_dispute.requires_response", data: { id: "dst_1" } });
  const mk = () => new WebhookVerifier("whsec", { now: () => NOW });
  it("accepts a correct signature once and flags a repeat", () => {
    const v = mk(), h = { timestamp: ts, signature: sign("whsec", ts, body) };
    const e = v.verify(body, h); expect(e).not.toBe("duplicate"); expect(isDisputeEvent(e as any)).toBe(true);
    expect(v.verify(body, h)).toBe("duplicate");
  });
  it("rejects a wrong secret, a changed body, a stale timestamp and missing headers", () => {
    expect(() => mk().verify(body, { timestamp: ts, signature: sign("other", ts, body) })).toThrow(/mismatch/);
    expect(() => mk().verify(body + " ", { timestamp: ts, signature: sign("whsec", ts, body) })).toThrow(/mismatch/);
    const old = String(NOW - 10 * 60_000);
    expect(() => mk().verify(body, { timestamp: old, signature: sign("whsec", old, body) })).toThrow(/tolerance/);
    expect(() => mk().verify(body, {})).toThrow(/headers/);
    expect(() => new WebhookVerifier("")).toThrow();
  });
});

describe("client resilience", () => {
  const mkClient = (responses: Response[], log: string[] = []) => {
    let i = 0;
    const f = (async (url: any, init: any) => { log.push(String(url).split(".com")[1] + " " + (init?.body ?? "")); return responses[i++] ?? new Response("{}", { status: 500 }); }) as any;
    return new AirwallexClient({ clientId: "c", apiKey: "k", fetchImpl: f, sleep: async () => {}, now: () => 0 });
  };
  const login = () => new Response(JSON.stringify({ token: "t" }), { status: 200 });
  it("logs in again once after a 401", async () => {
    const c = mkClient([login(), new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 }), login(), new Response(JSON.stringify({ id: "dst_1" }), { status: 200 })]);
    expect((await c.getDispute("dst_1")).id).toBe("dst_1");
  });
  it("retries a rate-limited POST with the same request_id", async () => {
    const log: string[] = [];
    const c = mkClient([login(), new Response("{}", { status: 429 }), new Response(JSON.stringify({ ok: 1 }), { status: 200 })], log);
    await c.accept("dst_1", "OTHERS", "me", "rid-1");
    const posts = log.filter((l) => l.includes("accept")); expect(posts.length).toBe(2); expect(posts[0]).toBe(posts[1]); expect(posts[0]).toContain("rid-1");
  });
  it("gives up after repeated rate limits", async () => {
    const c = mkClient([login(), new Response("{}", { status: 429 }), new Response("{}", { status: 429 }), new Response("{}", { status: 429 })]);
    await expect(c.getDispute("dst_1")).rejects.toThrow(/429/);
  });
});
