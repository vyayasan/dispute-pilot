import { describe, expect, it } from "vitest";
import type { CaseFacts } from "../src/domain/types.js";
import { assemble, assembleArtifacts, ceFootprintCheck, type EvidenceOrder } from "../src/evidence/assemble.js";

const facts: CaseFacts = { deviceIpMatchesPriorUndisputed: 2, signedDelivery: true, unansweredSupportEmails: 0 };
const disputed = { id: "current", createdAt: "2026-10-01T00:00:00.000Z", ip: "203.0.113.4", deviceId: "device-a", billingAddress: "10 Main St", paymentMethod: "card-1" };
const orderAt = (id: string, days: number, status = "undisputed", more: Partial<EvidenceOrder> = {}): EvidenceOrder => ({
  id, createdAt: new Date(Date.parse(disputed.createdAt) - days * 86_400_000).toISOString(), status,
  ip: "203.0.113.4", deviceId: "device-a", billingAddress: "10 Main St", paymentMethod: "card-1", ...more,
});

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("evidence generation", () => {
  it("creates real PDFs and JPEG with correct magic and no PNG", async () => {
    const artifacts = await assembleArtifacts(facts, [orderAt("o1", 120), orderAt("o2", 365)], [{ from: "buyer@example.test", subject: "Help" }], { label: "receipt scan", result: "delivery confirmed" }, disputed);
    expect(artifacts.map((a) => a.kind)).toEqual(["pdf", "pdf", "pdf", "jpg"]);
    for (const item of artifacts.filter((a) => a.kind === "pdf")) expect(Buffer.from(item.bytes).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const jpg = artifacts.find((a) => a.kind === "jpg")!;
    expect(hex(jpg.bytes.subarray(0, 3))).toBe("ffd8ff");
    expect(artifacts.every((a) => hex(a.bytes.subarray(0, 8)) !== "89504e470d0a1a0a")).toBe(true);
  });

  it("keeps bytes and sha256 stable for identical input", async () => {
    const inputs: [typeof facts, EvidenceOrder[], { subject: string; body: string }[], { label: string; result: string }, typeof disputed] = [facts, [orderAt("o1", 120), orderAt("o2", 365)], [{ subject: "Help", body: "Please assist" }], { label: "receipt", result: "ok" }, disputed];
    const first = await assembleArtifacts(...inputs);
    const second = await assembleArtifacts(...inputs);
    expect(first.map((a) => hex(a.bytes))).toEqual(second.map((a) => hex(a.bytes)));
    expect(await assemble(...inputs)).toEqual(await assemble(...inputs));
  });
});

describe("CE 3.0 footprint rules", () => {
  it("accepts two qualifying orders at 120 and 365 days", () => {
    const result = ceFootprintCheck([orderAt("edge-120", 120), orderAt("edge-365", 365)], disputed);
    expect(result.ok).toBe(true);
    expect(result.matched).toEqual(["edge-120", "edge-365"]);
  });

  it("excludes 119 and 366 days", () => {
    const result = ceFootprintCheck([orderAt("too-new", 119), orderAt("too-old", 366)], disputed);
    expect(result.ok).toBe(false);
    expect(result.matched).toEqual([]);
  });

  it("requires two of four elements and IP or device among them", () => {
    const onlyNonDevice = orderAt("a", 180, "undisputed", { ip: "other", deviceId: "other", billingAddress: "10 Main St", paymentMethod: "card-1" });
    const oneElement = orderAt("b", 180, "undisputed", { ip: "other", deviceId: "other", billingAddress: "10 Main St", paymentMethod: "other" });
    expect(ceFootprintCheck([onlyNonDevice, onlyNonDevice], disputed).ok).toBe(false);
    expect(ceFootprintCheck([oneElement, oneElement], disputed).ok).toBe(false);
  });

  it("requires prior undisputed orders", () => {
    expect(ceFootprintCheck([orderAt("won", 180, "challenged"), orderAt("future", -10)], disputed).ok).toBe(false);
  });
});
