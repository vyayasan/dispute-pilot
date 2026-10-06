import { z } from "zod";
import type { Action, CaseFacts, Dispute, EvidenceItem } from "../domain/types.js";
import { isLegal } from "../domain/stateMachine.js";

export const PolicySchema = z.object({
  version: z.string(),
  feePerDispute: z.number().nonnegative(), // configured here; the sandbox does not deduct it
  autonomyCap: z.number().positive(), // above this a person always decides
  minWinProbabilityToChallenge: z.number().min(0).max(1),
  escalateAfterUnansweredEmails: z.number().int().positive(),
  minHoursBeforeDue: z.number().nonnegative(),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({
  version: "2026-10-05.1", feePerDispute: 15, autonomyCap: 1000,
  minWinProbabilityToChallenge: 0.5, escalateAfterUnansweredEmails: 2, minHoursBeforeDue: 4,
});

export interface Decision { action: Action; reasons: string[]; winProbability: number; expectedValue: number }

// Deterministic evidence strength 0..1. Weights are visible so a reviewer can audit the math.
export function winProbability(d: Dispute, f: CaseFacts, evidence: EvidenceItem[]): number {
  let p = 0.1;
  if (d.reasonCode === "10.4") {
    p += Math.min(f.deviceIpMatchesPriorUndisputed, 3) * 0.2; // up to 0.6
    if (f.signedDelivery === true) p += 0.2;
  } else if (d.reasonCode === "13.1") {
    if (f.signedDelivery === true) p += 0.6;
  }
  if (evidence.length === 0) p = Math.min(p, 0.1);
  return Math.min(1, Math.round(p * 100) / 100);
}

export function decide(d: Dispute, f: CaseFacts, evidence: EvidenceItem[], pol: Policy, now: Date): Decision {
  const wp = winProbability(d, f, evidence);
  const ev = Math.round((wp * d.amount - pol.feePerDispute) * 100) / 100;
  const out = (action: Action, ...reasons: string[]): Decision => ({ action, reasons, winProbability: wp, expectedValue: ev });
  const hoursLeft = (Date.parse(d.dueAt) - now.getTime()) / 36e5;

  // Fail closed on malformed inputs before any economics are computed.
  if (!Number.isFinite(d.amount) || d.amount < 0) return out("ESCALATE", `invalid dispute amount (${String(d.amount)}): a person must check the source data`);
  if (!/^[A-Z]{3}$/.test(d.currency)) return out("ESCALATE", `unrecognised currency code "${String(d.currency).slice(0, 12)}": fee and autonomy cap are not defined for it`);
  if (f.mandateVerified === false) return out("ESCALATE", "agent purchase mandate failed verification: a person must review before any evidence is submitted");
  if (f.evidenceRejectedByBank) return out("ESCALATE", "issuer rejected the evidence: re-challenge needs a person to review the rejection reason");
  if (f.unansweredSupportEmails >= pol.escalateAfterUnansweredEmails)
    return out("ESCALATE", `${f.unansweredSupportEmails} support emails unanswered: a person must respond`);
  if (d.amount > pol.autonomyCap) return out("ESCALATE", `amount ${d.amount} above autonomy cap ${pol.autonomyCap}`);
  if (!(hoursLeft >= pol.minHoursBeforeDue)) return out("ESCALATE", `only ${hoursLeft.toFixed(1)}h to deadline`);
  if (d.amount <= pol.feePerDispute) return out("ACCEPT", `fee ${pol.feePerDispute} >= amount ${d.amount}`);
  if (wp >= pol.minWinProbabilityToChallenge && ev > 0 && isLegal(d, "CHALLENGE"))
    return out("CHALLENGE", `win probability ${wp} and expected value ${ev} after fee`);
  return out(isLegal(d, "ACCEPT") ? "ACCEPT" : "ESCALATE", `weak evidence (p=${wp}), expected value ${ev}`);
}
