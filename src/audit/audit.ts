import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// Append-only audit trail. Each entry carries the hash of the previous one, so removing or editing
// a line breaks the chain and verifyChain() reports it. Entries never contain keys or tokens.
export interface AuditEntry { seq: number; ts: string; kind: string; disputeId?: string; detail: Record<string, unknown>; prev: string; hash: string }

const hashOf = (e: Omit<AuditEntry, "hash">) => createHash("sha256").update(JSON.stringify([e.seq, e.ts, e.kind, e.disputeId ?? null, e.detail, e.prev])).digest("hex");

export class AuditLog {
  private entries: AuditEntry[] = [];
  constructor(private file?: string, private now: () => Date = () => new Date()) {}
  append(kind: string, detail: Record<string, unknown> = {}, disputeId?: string): AuditEntry {
    const prev = this.entries.at(-1)?.hash ?? "genesis";
    const base = { seq: this.entries.length + 1, ts: this.now().toISOString(), kind, disputeId, detail, prev };
    const entry: AuditEntry = { ...base, hash: hashOf(base) };
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, JSON.stringify(entry) + "\n");
    return entry;
  }
  list(): readonly AuditEntry[] { return this.entries; }
}

export function verifyChain(entries: readonly AuditEntry[]): { ok: boolean; brokenAt?: number } {
  let prev = "genesis";
  for (const e of entries) {
    const { hash, ...rest } = e;
    if (e.prev !== prev || hashOf(rest) !== hash) return { ok: false, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true };
}
