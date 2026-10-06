import { describe, it, expect } from "vitest";
import { issue, ApprovalVerifier } from "../../src/approval/approval.js";
import { decide, DEFAULT_POLICY } from "../../src/policy/policy.js";
import type { Dispute } from "../../src/domain/types.js";

const d: Dispute = { id: "d1", amount: 250, currency: "USD", reasonCode: "10.4", stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: "2026-12-01T00:00:00Z" };
const ev = ["aa"]; const KEY = "k".repeat(32);
const mk = (x: Dispute = d) => issue(x, "CHALLENGE", ev, "p1", "sandi", KEY, 60_000);

describe("red team: approval binding", () => {
  it("currency case change is a different currency", () => expect(new ApprovalVerifier(KEY).check(mk(), { ...d, currency: "usd" }, "CHALLENGE", ev)).toBe("currency changed"));
  it("float drift in live amount is refused (0.1+0.2 style)", () => {
    const x = { ...d, amount: 0.1 + 0.2 }; expect(new ApprovalVerifier(KEY).check(mk({ ...d, amount: 0.3 }), x, "CHALLENGE", ev)).toBe("amount changed");
  });
  it("reason code spoof 10.4 -> 10.40 refused", () => expect(new ApprovalVerifier(KEY).check(mk(), { ...d, reasonCode: "10.40" }, "CHALLENGE", ev)).toBe("reason code changed"));
  it("token field smuggling: changing approver invalidates signature", () => { const a = { ...mk(), approver: "attacker" }; expect(new ApprovalVerifier(KEY).check(a, d, "CHALLENGE", ev)).toBe("bad signature"); });
  it("extended expiry in token is refused", () => { const a = { ...mk(), expiresAt: "2099-01-01T00:00:00Z" }; expect(new ApprovalVerifier(KEY).check(a, d, "CHALLENGE", ev)).toBe("bad signature"); });
  it("expiry boundary: refused at exactly expiresAt", () => { const a = mk(); expect(new ApprovalVerifier(KEY).check(a, d, "CHALLENGE", ev, new Date(a.expiresAt))).toBe("approval expired"); });
  it("empty / garbage signature is refused without throwing", () => { for (const sig of ["", "zz", "a".repeat(64)]) expect(new ApprovalVerifier(KEY).check({ ...mk(), sig }, d, "CHALLENGE", ev)).toBe("bad signature"); });
  it("evidence order does not matter but content does", () => {
    const a = issue(d, "CHALLENGE", ["b", "a"], "p1", "s", KEY, 60_000);
    expect(new ApprovalVerifier(KEY).check(a, d, "CHALLENGE", ["a", "b"])).toBeNull();
    expect(new ApprovalVerifier(KEY).check(a, d, "CHALLENGE", ["a"])).toBe("evidence changed");
  });
  it("approval for one dispute cannot be used on another", () => expect(new ApprovalVerifier(KEY).check(mk(), { ...d, id: "d2" }, "CHALLENGE", ev)).toBe("dispute mismatch"));
});

describe("red team: policy", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const f = { deviceIpMatchesPriorUndisputed: 99, signedDelivery: true as const, unansweredSupportEmails: 0 };
  const evi = [{ name: "p.pdf", sha256: "aa", kind: "pdf" as const }];
  it("inflated match count cannot push probability above 1", () => expect(decide(d, f, evi, DEFAULT_POLICY, now).winProbability).toBeLessThanOrEqual(1));
  it("negative or zero amount never challenges", () => { for (const amount of [0, -5]) expect(decide({ ...d, amount }, f, evi, DEFAULT_POLICY, now).action).not.toBe("CHALLENGE"); });
  it("past-due dispute escalates", () => expect(decide({ ...d, dueAt: "2026-10-01T00:00:00Z" }, f, evi, DEFAULT_POLICY, now).action).toBe("ESCALATE"));
  it("garbage dueAt (NaN) fails closed to escalate", () => expect(decide({ ...d, dueAt: "not-a-date" }, f, evi, DEFAULT_POLICY, now).action).toBe("ESCALATE"));
  it("unsigned delivery on 13.1 cannot be challenged", () => expect(decide({ ...d, reasonCode: "13.1" }, { ...f, signedDelivery: false }, evi, DEFAULT_POLICY, now).action).not.toBe("CHALLENGE"));
});
