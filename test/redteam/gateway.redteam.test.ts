import { describe, expect, it } from "vitest";
import { AirwallexClient } from "../../src/gateway/airwallex.js";

describe("red team: gateway retry identity", () => {
  it("uses a fresh request_id for a repeated mutation, so a logical retry is not idempotent", async () => {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, init });
      const login = url.endsWith("/authentication/login");
      return { ok: true, status: 200, json: async () => login ? { token: "t" } : {} };
    }) as typeof fetch;
    const client = new AirwallexClient({ clientId: "id", apiKey: "secret", fetchImpl });
    await client.accept("d-1", "LOW_VALUE_TRANSACTION", "reviewer");
    await client.accept("d-1", "LOW_VALUE_TRANSACTION", "reviewer");
    const ids = calls.filter((x) => !x.url.endsWith("/authentication/login"))
      .map((x) => JSON.parse(String(x.init.body)).request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
