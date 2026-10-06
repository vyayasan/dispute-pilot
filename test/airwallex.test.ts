import { describe, it, expect } from "vitest";
import { AirwallexClient, AirwallexError } from "../src/gateway/airwallex.js";

function mock(handler: (url: string, init: any) => { status?: number; body: any }) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => { calls.push({ url, init }); const r = handler(url, init); return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body }; }) as any;
  return { calls, fetchImpl };
}
const login = (u: string) => u.endsWith("/authentication/login");

describe("airwallex client", () => {
  it("logs in once and reuses the token", async () => {
    const m = mock((u) => (login(u) ? { body: { token: "t1" } } : { body: { items: [] } }));
    const c = new AirwallexClient({ clientId: "id", apiKey: "k", fetchImpl: m.fetchImpl });
    await c.listDisputes(); await c.listDisputes();
    expect(m.calls.filter((x) => login(x.url)).length).toBe(1);
    expect(m.calls[1].init.headers.authorization).toBe("Bearer t1");
  });
  it("refreshes an expiring token", async () => {
    let t = 0; const m = mock((u) => (login(u) ? { body: { token: "t" } } : { body: {} }));
    const c = new AirwallexClient({ clientId: "id", apiKey: "k", fetchImpl: m.fetchImpl, now: () => t, sleep: async () => {} });
    await c.listDisputes(); t = 26 * 60_000; await c.listDisputes();
    expect(m.calls.filter((x) => login(x.url)).length).toBe(2);
  });
  it("sends a fresh UUID request_id on every mutation", async () => {
    const m = mock((u) => (login(u) ? { body: { token: "t" } } : { body: {} }));
    const c = new AirwallexClient({ clientId: "id", apiKey: "k", fetchImpl: m.fetchImpl });
    await c.accept("d1", "LOW_VALUE_TRANSACTION", "pilot"); await c.accept("d1", "LOW_VALUE_TRANSACTION", "pilot");
    const ids = m.calls.filter((x) => x.init.method === "POST" && !login(x.url)).map((x) => JSON.parse(x.init.body).request_id);
    expect(new Set(ids).size).toBe(2); expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("raises typed errors", async () => {
    const m = mock((u) => (login(u) ? { body: { token: "t" } } : { status: 400, body: { code: "validation_error", message: "Dispute transition is not supported" } }));
    const c = new AirwallexClient({ clientId: "id", apiKey: "k", fetchImpl: m.fetchImpl });
    await expect(c.simulateEscalate("d", "2026-10-14T00:00:00.000Z")).rejects.toBeInstanceOf(AirwallexError);
  });
  it("fails closed on bad credentials and never leaks the key", async () => {
    const m = mock(() => ({ status: 401, body: { code: "credentials_invalid", message: "bad" } }));
    const c = new AirwallexClient({ clientId: "id", apiKey: "SECRETKEY", fetchImpl: m.fetchImpl });
    const e = await c.listDisputes().catch((x) => x); expect(String(e.message)).not.toContain("SECRETKEY");
  });
  it("requires credentials", () => expect(() => new AirwallexClient({ clientId: "", apiKey: "" })).toThrow());
  it("throttles to maxRps", async () => {
    let t = 0; const slept: number[] = []; const m = mock((u) => (login(u) ? { body: { token: "t" } } : { body: {} }));
    const c = new AirwallexClient({ clientId: "id", apiKey: "k", fetchImpl: m.fetchImpl, maxRps: 2, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    await c.listDisputes(); await c.listDisputes(); await c.listDisputes();
    expect(slept.length).toBeGreaterThan(0);
  });
});
