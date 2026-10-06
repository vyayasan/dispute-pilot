import { describe, expect, it } from "vitest";
import { ApprovalVerifier, issue } from "../../src/approval/approval.js";
import type { Dispute } from "../../src/domain/types.js";

const d: Dispute = { id: "d", amount: 10, currency: "USD", reasonCode: "x", stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: "2027-01-01T00:00:00Z" };
const key = "nonce-test-key-long-enough-to-be-safe";

describe("red team: replay-store retention (FIXED: pruned once expired)", () => {
  it("prunes consumed nonces after their approvals have expired", () => {
    const verifier = new ApprovalVerifier(key);
    for (let i = 0; i < 100; i++) {
      const approval = issue(d, "ACCEPT", [], "p", "r", key, 1, new Date(0));
      // The Set is a process-lifetime replay ledger; expiry does not prune it.
      verifier.consume({ ...approval, nonce: `${approval.nonce}-${i}` });
    }
    expect(verifier.size).toBe(100);
    const fresh = issue(d, "ACCEPT", [], "p", "r", key, 60_000);
    expect(verifier.check(fresh, d, "ACCEPT", [])).toBeNull(); // check prunes expired entries
    expect(verifier.size).toBe(0);
  });
});
