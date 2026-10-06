import type { Action, CaseFacts, Dispute, EvidenceItem } from "../domain/types.js";
import { isLegal } from "../domain/stateMachine.js";
import type { Case, Gateway } from "../sim/simGateway.js";
import type { AirwallexClient } from "./airwallex.js";

export interface LiveGatewayOptions {
  client: Pick<AirwallexClient, "listDisputes" | "getDispute" | "accept" | "challenge" | "uploadFile">;
  /** What the merchant knows about the order. Airwallex does not hold it, so the caller supplies it. */
  factsFor: (dispute: Dispute, raw: any) => CaseFacts;
  /** Person on whose approval the action is taken; sent to Airwallex as accepted_by / challenged_by. */
  actor: string;
  /** Under this amount (major units) an accept is filed as a low-value acceptance. */
  lowValueBelow?: number;
}

const toDispute = (j: any): Dispute => ({
  id: j.id, amount: j.amount, currency: j.currency, reasonCode: j.reason?.original_code ?? "", stage: j.stage, status: j.status, dueAt: j.due_at,
});

/**
 * The same Gateway interface as the simulator, backed by the Airwallex sandbox.
 * Escalation is a handoff to a person: it makes no Airwallex call and is recorded on the case.
 */
export class LiveGateway implements Gateway {
  private cases = new Map<string, Case>();
  private pending = new Map<string, { evidence: EvidenceItem; fileId?: string; bytes: Uint8Array }[]>();
  constructor(private o: LiveGatewayOptions) {}

  private merge(raw: any): Case {
    const d = toDispute(raw);
    const prior = this.cases.get(d.id);
    const facts = { ...this.o.factsFor(d, raw), ...(prior?.facts.evidenceRejectedByBank || (raw.challenge_details ?? []).length > 0 ? { evidenceRejectedByBank: true } : {}) };
    const c: Case = { dispute: d, facts, evidence: prior?.evidence ?? [], story: prior?.story ?? `Live Airwallex dispute ${d.id}`, log: prior?.log ?? [] };
    // A person's own handoff outranks what the remote still shows as open.
    if (prior?.dispute.status === "ESCALATED" && d.status === "REQUIRES_RESPONSE") c.dispute.status = "ESCALATED";
    this.cases.set(d.id, c);
    return c;
  }
  async list(): Promise<Case[]> { return (await this.o.client.listDisputes()).items.map((j) => this.merge(j)); }
  async get(id: string): Promise<Case | undefined> {
    try { return this.merge(await this.o.client.getDispute(id)); } catch (e: any) { if (e?.status === 404) return undefined; throw e; }
  }
  attachEvidence(id: string, file: { name: string; kind: "jpg" | "pdf"; bytes: Uint8Array; sha256: string }): EvidenceItem {
    const c = this.cases.get(id); if (!c) throw new Error("load the dispute before attaching evidence");
    const item: EvidenceItem = { name: file.name, sha256: file.sha256, kind: file.kind };
    c.evidence.push(item); c.log.push(`Evidence staged: ${file.name}`);
    this.pending.set(id, [...(this.pending.get(id) ?? []), { evidence: item, bytes: file.bytes }]);
    return item;
  }
  async apply(id: string, action: Action): Promise<string> {
    const c = await this.get(id); if (!c) throw new Error("dispute not found");
    if (!isLegal(c.dispute, action)) throw new Error(`illegal ${action} in ${c.dispute.stage}/${c.dispute.status}`);
    // The approval nonce is not visible here, so a stable id per dispute+action+stage stops a double submit after a timeout.
    const requestId = `dp-${id}-${action}-${c.dispute.stage}`;
    if (action === "ACCEPT") {
      const reason = c.dispute.amount < (this.o.lowValueBelow ?? 25) ? "LOW_VALUE_TRANSACTION" : "VALID_CUSTOMER_DISPUTE";
      await this.o.client.accept(id, reason, this.o.actor, requestId);
      return "ACCEPTED, refund issued";
    }
    if (action === "CHALLENGE") {
      const staged = this.pending.get(id) ?? [];
      if (staged.length === 0 && c.evidence.length === 0) throw new Error("a challenge needs at least one JPG or PDF");
      const fileIds: string[] = [];
      for (const s of staged) {
        const up = await this.o.client.uploadFile(s.evidence.name, s.bytes, s.evidence.kind === "jpg" ? "image/jpeg" : "application/pdf");
        fileIds.push(up.file_id);
      }
      await this.o.client.challenge(id, this.o.actor, { supporting_documents: { documents: [{ description: "Evidence submitted after reviewer approval", file_ids: fileIds }] } }, requestId);
      this.pending.delete(id);
      return "CHALLENGED, awaiting issuer";
    }
    c.dispute.status = "ESCALATED"; c.log.push("Escalated to a person; no Airwallex action taken.");
    return "ESCALATED to a person";
  }
}
