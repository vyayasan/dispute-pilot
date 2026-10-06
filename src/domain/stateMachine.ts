import type { Action, CaseFacts, Dispute } from "./types.js";

// Guard table: an action is only legal in a stage + status. Encoded from the
// Airwallex dispute flow docs. ESCALATE at CHARGEBACK is our internal handoff to a person
// (the Airwallex simulator rejects escalating from CHARGEBACK, so we never call it there).
// After an issuer rejection the evidence has had its one shot, so CHALLENGE is removed.
export function legalActions(d: Pick<Dispute, "stage" | "status">, facts?: Pick<CaseFacts, "evidenceRejectedByBank">): Action[] {
  if (d.status !== "REQUIRES_RESPONSE") return [];
  let out: Action[];
  switch (d.stage) {
    case "RFI": out = ["ACCEPT", "CHALLENGE", "ESCALATE"]; break;
    case "CHARGEBACK": out = ["ACCEPT", "CHALLENGE", "ESCALATE"]; break;
    default: out = ["ESCALATE"]; // pre-chargeback auto-accepts; later stages go to a person
  }
  return facts?.evidenceRejectedByBank ? out.filter((a) => a !== "CHALLENGE") : out;
}
export const isLegal = (d: Dispute, a: Action, facts?: Pick<CaseFacts, "evidenceRejectedByBank">) => legalActions(d, facts).includes(a);
