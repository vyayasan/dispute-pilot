import { describe, it, expect } from "vitest";
import { fromDisputeWebhook, fromCustomerEmail, fromEvidenceUpload, fromIssuerLetterPdf } from "../src/intake/intake.js";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

describe("case intake", () => {
  it("ingests a dispute webhook with provenance", () => {
    const r = fromDisputeWebhook({ event: "dispute.created", data: { id: "dsp_1", amount: 480, currency: "USD", reason_code: "10.4" } });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("dsp_1");
    expect(r.text).toContain("10.4");
    expect(r.provenance).toContain("dispute.created");
  });
  it("rejects non-dispute events and incomplete payloads", () => {
    expect(fromDisputeWebhook({ event: "payment.settled", data: { id: "dsp_1" } }).ok).toBe(false);
    expect(fromDisputeWebhook({ event: "dispute.created", data: { id: "dsp_1" } }).ok).toBe(false);
    expect(fromDisputeWebhook({ event: "dispute.created", data: undefined }).ok).toBe(false);
  });
  it("ingests a customer email with sender provenance", () => {
    const r = fromCustomerEmail({ from: "customer@example.com", subject: "I never made this purchase", text: "This was not me.", receivedAt: "2026-10-06T11:00:00Z" });
    expect(r.ok).toBe(true);
    expect(r.provenance).toContain("customer@example.com");
  });
  it("evidence upload accepts JPG and PDF by signature, rejects other bytes", () => {
    expect(fromEvidenceUpload("scan.jpg", JPG).ok).toBe(true);
    expect(fromEvidenceUpload("letter.pdf", PDF).ok).toBe(true);
    expect(fromEvidenceUpload("notes.txt", new Uint8Array([0x68, 0x69])).ok).toBe(false);
  });
  it("issuer letter PDF fails closed without an extractor, extracts with one", async () => {
    expect((await fromIssuerLetterPdf("letter.pdf", PDF)).ok).toBe(false);
    const r = await fromIssuerLetterPdf("letter.pdf", PDF, async () => "Chargeback 480.00 USD reason 10.4");
    expect(r.ok).toBe(true);
    expect(r.provenance).toContain("letter.pdf");
    expect((await fromIssuerLetterPdf("scan.jpg", JPG, async () => "x")).ok).toBe(false);
  });
  it("rejects empty and oversized text", () => {
    expect(fromCustomerEmail({ from: "a@b.c", subject: "s", text: "   " }).ok).toBe(false);
    expect(fromCustomerEmail({ from: "a@b.c", subject: "s", text: "a".repeat(21_000) }).ok).toBe(false);
  });
});
