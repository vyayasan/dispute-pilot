import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Action, CaseFacts, Dispute } from "../domain/types.js";
import { isLegal } from "../domain/stateMachine.js";

export interface Approval {
  disputeId: string; action: Action; amount: number; currency: string; reasonCode: string;
  stage: string; status: string; evidenceSha256: string[]; policyVersion: string;
  approver: string; expiresAt: string; nonce: string; rationale: string; sig: string;
}
type Body = Omit<Approval, "sig">;

const canon = (b: Body) => JSON.stringify([b.disputeId, b.action, b.amount, b.currency, b.reasonCode, b.stage, b.status,
  [...b.evidenceSha256].sort(), b.policyVersion, b.approver, b.expiresAt, b.nonce, b.rationale]);
const sign = (b: Body, key: string) => createHmac("sha256", key).update(canon(b)).digest("hex");

export function issue(d: Dispute, action: Action, evidenceSha256: string[], policyVersion: string,
  approver: string, key: string, ttlMs: number, now = new Date(), rationale = ""): Approval {
  const body: Body = { disputeId: d.id, action, amount: d.amount, currency: d.currency, reasonCode: d.reasonCode,
    stage: d.stage, status: d.status, evidenceSha256, policyVersion, approver,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(), nonce: randomUUID(), rationale: rationale.slice(0, 1024) };
  return { ...body, sig: sign(body, key) };
}

export class ApprovalVerifier {
  // nonce -> expiry (ms). Entries are pruned once the approval could no longer pass the expiry check anyway.
  private used = new Map<string, number>();
  constructor(private key: string) {}
  // Returns null if the approval may be executed against the LIVE dispute, else the refusal reason.
  check(a: Approval, live: Dispute, action: Action, evidenceSha256: string[], now = new Date(), facts?: Pick<CaseFacts, "evidenceRejectedByBank">): string | null {
    this.prune(now);
    const { sig, ...body } = a;
    const good = Buffer.from(sign(body, this.key)); const got = Buffer.from(String(sig));
    if (good.length !== got.length || !timingSafeEqual(good, got)) return "bad signature";
    if (this.used.has(a.nonce)) return "approval already used";
    if (Date.parse(a.expiresAt) <= now.getTime()) return "approval expired";
    if (a.action !== action) return "action mismatch";
    if (a.disputeId !== live.id) return "dispute mismatch";
    if (a.amount !== live.amount) return "amount changed";
    if (a.currency !== live.currency) return "currency changed";
    if (a.reasonCode !== live.reasonCode) return "reason code changed";
    if (a.stage !== live.stage || a.status !== live.status) return "stage or status changed";
    if (!isLegal(live, action, facts)) return "action not legal in live state";
    if (JSON.stringify([...a.evidenceSha256].sort()) !== JSON.stringify([...evidenceSha256].sort())) return "evidence changed";
    return null;
  }
  consume(a: Approval) { this.used.set(a.nonce, Date.parse(a.expiresAt)); }
  get size() { return this.used.size; }
  private prune(now: Date) { for (const [n, exp] of this.used) if (exp <= now.getTime()) this.used.delete(n); }
}
