import { describe, it, expect } from "vitest";
import { issue, ApprovalVerifier } from "../src/approval/approval.js";
import type { Dispute } from "../src/domain/types.js";

const d: Dispute = { id: "d1", amount: 250, currency: "USD", reasonCode: "10.4", stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: "2026-12-01T00:00:00Z" };
const ev = ["aa", "bb"]; const KEY = "k".repeat(32);
const mk = () => issue(d, "CHALLENGE", ev, "p1", "sandi", KEY, 60_000);

describe("approval binding (red team)", () => {
  it("accepts the exact bound action", () => expect(new ApprovalVerifier(KEY).check(mk(), d, "CHALLENGE", ev)).toBeNull());
  it("refuses tampered amount in the token", () => { const a = { ...mk(), amount: 2 }; expect(new ApprovalVerifier(KEY).check(a, d, "CHALLENGE", ev)).toBe("bad signature"); });
  it("refuses when live amount changed", () => expect(new ApprovalVerifier(KEY).check(mk(), { ...d, amount: 251 }, "CHALLENGE", ev)).toBe("amount changed"));
  it("refuses when live currency changed", () => expect(new ApprovalVerifier(KEY).check(mk(), { ...d, currency: "EUR" }, "CHALLENGE", ev)).toBe("currency changed"));
  it("refuses when reason code changed", () => expect(new ApprovalVerifier(KEY).check(mk(), { ...d, reasonCode: "13.1" }, "CHALLENGE", ev)).toBe("reason code changed"));
  it("refuses a different action", () => expect(new ApprovalVerifier(KEY).check(mk(), d, "ACCEPT", ev)).toBe("action mismatch"));
  it("refuses swapped evidence", () => expect(new ApprovalVerifier(KEY).check(mk(), d, "CHALLENGE", ["aa", "cc"])).toBe("evidence changed"));
  it("refuses after expiry", () => expect(new ApprovalVerifier(KEY).check(mk(), d, "CHALLENGE", ev, new Date(Date.now() + 120_000))).toBe("approval expired"));
  it("refuses replay", () => { const v = new ApprovalVerifier(KEY); const a = mk(); v.consume(a); expect(v.check(a, d, "CHALLENGE", ev)).toBe("approval already used"); });
  it("refuses a token signed with another key", () => expect(new ApprovalVerifier("x".repeat(32)).check(mk(), d, "CHALLENGE", ev)).toBe("bad signature"));
  it("refuses an illegal state (CHALLENGE after chargeback escalation of a challenged case)", () => {
    const live = { ...d, status: "CHALLENGED" as const };
    const a = issue(live, "CHALLENGE", ev, "p1", "sandi", KEY, 60_000);
    expect(new ApprovalVerifier(KEY).check(a, live, "CHALLENGE", ev)).toBe("action not legal in live state");
  });
});
