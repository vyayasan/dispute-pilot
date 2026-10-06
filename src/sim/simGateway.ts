import type { Dispute, CaseFacts, EvidenceItem, Action } from "../domain/types.js";
import { isLegal } from "../domain/stateMachine.js";

// In-memory stand-in for the Airwallex sandbox. The real gateway implements the same interface.
export interface Case { dispute: Dispute; facts: CaseFacts; evidence: EvidenceItem[]; story: string; log: string[] }
type Maybe<T> = T | Promise<T>;
// Either side may be async: the sandbox gateway talks over the network, the simulator does not.
export interface Gateway {
  list(): Maybe<Case[]>;
  get(id: string): Maybe<Case | undefined>;
  apply(id: string, action: Action): Maybe<string>; // returns resulting status text
  /** Optional: attach a JPG or PDF the reviewer supplied. Returns the stored evidence item. */
  attachEvidence?(id: string, file: { name: string; kind: "jpg" | "pdf"; bytes: Uint8Array; sha256: string }): Maybe<EvidenceItem>;
}

const sha = (s: string) => Array.from(s).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0").repeat(8);

// The simulator is synchronous; tests rely on that, and it is still a valid Gateway.
export type SimGateway = Omit<Gateway, "list" | "get" | "apply"> & { list(): Case[]; get(id: string): Case | undefined; apply(id: string, action: Action): string };

export function makeSim(now = new Date()): SimGateway {
  const due = (days: number) => new Date(now.getTime() + days * 864e5).toISOString();
  const cases: Case[] = [
    { dispute: { id: "dsp_demo_fraud", amount: 480, currency: "USD", reasonCode: "10.4", stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: due(9) },
      facts: { deviceIpMatchesPriorUndisputed: 3, signedDelivery: true, unansweredSupportEmails: 0 },
      evidence: [{ name: "order-footprint.pdf", sha256: sha("footprint"), kind: "pdf" }, { name: "delivery-signature.jpg", sha256: sha("signature"), kind: "jpg" }],
      story: "Customer claims fraud. Device fingerprint and IP match 3 prior undisputed orders; signed delivery on file.", log: [] },
    { dispute: { id: "dsp_demo_small", amount: 9, currency: "USD", reasonCode: "13.1", stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: due(9) },
      facts: { deviceIpMatchesPriorUndisputed: 0, signedDelivery: false, unansweredSupportEmails: 0 },
      evidence: [{ name: "delivery-scan.jpg", sha256: sha("scan"), kind: "jpg" }],
      story: "Not-received claim. Delivery scan has no signature. The dispute fee is larger than the amount.", log: [] },
    { dispute: { id: "dsp_demo_credit", amount: 120, currency: "USD", reasonCode: "13.6", stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: due(9) },
      facts: { deviceIpMatchesPriorUndisputed: 0, signedDelivery: null, unansweredSupportEmails: 2 },
      evidence: [{ name: "support-thread.pdf", sha256: sha("thread"), kind: "pdf" }],
      story: "Credit not processed. Customer emailed support twice and got no reply.", log: [] },
  ];
  return {
    attachEvidence(id, file) {
      const c = cases.find((x) => x.dispute.id === id);
      if (!c) throw new Error("dispute not found");
      const item: EvidenceItem = { name: file.name, sha256: file.sha256, kind: file.kind };
      c.evidence.push(item); c.log.push(`Evidence added: ${file.name}`);
      return item;
    },
    list: () => cases,
    get: (id) => cases.find((c) => c.dispute.id === id),
    apply(id, action) {
      const c = cases.find((x) => x.dispute.id === id)!;
      if (!isLegal(c.dispute, action)) throw new Error(`illegal ${action} in ${c.dispute.stage}/${c.dispute.status}`);
      if (action === "ACCEPT") { c.dispute.status = "ACCEPTED"; return "ACCEPTED, refund issued"; }
      if (action === "ESCALATE" && c.facts.unansweredSupportEmails >= 2) { c.dispute.status = "ESCALATED"; c.log.push("Escalated to a person; assigned to support lead."); return "ESCALATED to a person"; }
      if (action === "CHALLENGE") {
        c.dispute.status = "CHALLENGED";
        // Simulator beat: issuer rejects the evidence, case returns at CHARGEBACK needing a response.
        c.dispute.stage = "CHARGEBACK"; c.dispute.status = "REQUIRES_RESPONSE";
        c.facts.evidenceRejectedByBank = true;
        c.log.push("Challenge submitted. Issuer rejected the evidence; case is back at CHARGEBACK, requires response.");
        return "CHALLENGED, then issuer rejected: back at CHARGEBACK";
      }
      c.dispute.status = "ESCALATED"; c.log.push("Escalated to a person for review."); return "ESCALATED to a person";
    },
  };
}
