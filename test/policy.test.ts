import { describe, it, expect } from "vitest";
import { decide, DEFAULT_POLICY } from "../src/policy/policy.js";
import type { Dispute, EvidenceItem } from "../src/domain/types.js";
const now = new Date("2026-11-01T00:00:00Z");
const ev: EvidenceItem[] = [{ name: "pack.pdf", sha256: "aa", kind: "pdf" }];
const base: Dispute = { id: "d", amount: 480, currency: "USD", reasonCode: "10.4", stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: "2026-11-10T00:00:00Z" };
describe("kit 4 scenarios", () => {
  it("challenges strong 10.4", () => expect(decide(base, { deviceIpMatchesPriorUndisputed: 3, signedDelivery: true, unansweredSupportEmails: 0 }, ev, DEFAULT_POLICY, now).action).toBe("CHALLENGE"));
  it("accepts small 13.1 when fee exceeds amount", () => expect(decide({ ...base, amount: 9, reasonCode: "13.1" }, { deviceIpMatchesPriorUndisputed: 0, signedDelivery: false, unansweredSupportEmails: 0 }, ev, DEFAULT_POLICY, now).action).toBe("ACCEPT"));
  it("escalates 13.6 with unanswered emails", () => expect(decide({ ...base, reasonCode: "13.6" }, { deviceIpMatchesPriorUndisputed: 0, signedDelivery: null, unansweredSupportEmails: 2 }, ev, DEFAULT_POLICY, now).action).toBe("ESCALATE"));
  it("never challenges with no evidence", () => expect(decide(base, { deviceIpMatchesPriorUndisputed: 3, signedDelivery: true, unansweredSupportEmails: 0 }, [], DEFAULT_POLICY, now).action).not.toBe("CHALLENGE"));
  it("escalates above autonomy cap", () => expect(decide({ ...base, amount: 5000 }, { deviceIpMatchesPriorUndisputed: 3, signedDelivery: true, unansweredSupportEmails: 0 }, ev, DEFAULT_POLICY, now).action).toBe("ESCALATE"));
  it("escalates near deadline", () => expect(decide({ ...base, dueAt: "2026-11-01T01:00:00Z" }, { deviceIpMatchesPriorUndisputed: 3, signedDelivery: true, unansweredSupportEmails: 0 }, ev, DEFAULT_POLICY, now).action).toBe("ESCALATE"));
});
