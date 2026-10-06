// Post-rejection re-decision against live sandbox state. Reads dispute state through a local
// auth proxy (PROXY=http://127.0.0.1:8788), runs the policy, writes a hash-chained audit trail.
import { readFileSync, writeFileSync } from "node:fs";
import { decide, DEFAULT_POLICY } from "../src/policy/policy.js";
import { legalActions } from "../src/domain/stateMachine.js";
import { AuditLog, verifyChain } from "../src/audit/audit.js";
import type { Dispute, CaseFacts } from "../src/domain/types.js";

const proxy = process.env.PROXY ?? "http://127.0.0.1:8788";
const ids = JSON.parse(readFileSync("runs/disputes.json", "utf8")) as Record<string, string>;
const audit = new AuditLog("runs/audit-live.jsonl");
const live = async (id: string) => {
  const j: any = await (await fetch(`${proxy}/api/v1/pa/payment_disputes/${id}`)).json();
  const d: Dispute = { id: j.id, amount: j.amount, currency: j.currency, reasonCode: j.reason.original_code, stage: j.stage, status: j.status, dueAt: j.due_at };
  return { d, challenges: (j.challenge_details ?? []).length };
};
const out: Record<string, unknown> = {};

const fraud = await live(ids.fraud);
const factsF: CaseFacts = { deviceIpMatchesPriorUndisputed: 3, signedDelivery: true, unansweredSupportEmails: 0, evidenceRejectedByBank: fraud.challenges > 0 };
audit.append("live.state", { stage: fraud.d.stage, status: fraud.d.status, priorChallenges: fraud.challenges }, ids.fraud);
const decF = decide(fraud.d, factsF, [], DEFAULT_POLICY, new Date());
const legalF = legalActions(fraud.d, factsF);
audit.append("decision.post_rejection", { action: decF.action, reasons: decF.reasons, legalActions: legalF, note: "issuer rejected evidence; one shot used, a person decides" }, ids.fraud);
out.fraud = { stage: fraud.d.stage, status: fraud.d.status, legalActions: legalF, decision: decF.action, reasons: decF.reasons };

const credit = await live(ids.credit);
const factsC: CaseFacts = { deviceIpMatchesPriorUndisputed: 0, signedDelivery: null, unansweredSupportEmails: 2 };
const decC = decide(credit.d, factsC, [], DEFAULT_POLICY, new Date());
audit.append("decision.credit_case", { action: decC.action, reasons: decC.reasons, escalated_in_sandbox: credit.d.stage === "CHARGEBACK" }, ids.credit);
out.credit = { stage: credit.d.stage, status: credit.d.status, decision: decC.action, reasons: decC.reasons };

const v = verifyChain(audit.list());
audit.append("run.summary", { chainOk: v.ok, entries: audit.list().length });
out.chain = verifyChain(audit.list());
writeFileSync("runs/redecision.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
