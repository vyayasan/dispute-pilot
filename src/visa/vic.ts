import { createHash } from "node:crypto";
import { z } from "zod";
import type { Dispute, EvidenceItem } from "../domain/types.js";
import type { TapVerificationResult } from "./tap.js";

/** The local adapter shape is not a live Visa VIC integration. */
export interface InstructionProvider {
  getInstruction(id: string): Promise<VicInstruction | undefined> | VicInstruction | undefined;
}

export interface VicInstruction {
  instructionId: string;
  maxAmount: number;
  currency: string;
  merchant: string;
  expiresAt: string;
  userAuthenticated: boolean;
}

const instructionSchema = z.object({
  instructionId: z.string().min(1),
  maxAmount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  merchant: z.string().min(1),
  expiresAt: z.string().datetime(),
  userAuthenticated: z.boolean()
});

/** A deterministic fixture-backed provider for tests and local demos. */
export class FixtureInstructionProvider implements InstructionProvider {
  private readonly instructions = new Map<string, VicInstruction>();

  constructor(fixtures: readonly VicInstruction[] = []) {
    for (const fixture of fixtures) {
      const parsed = instructionSchema.parse(fixture);
      this.instructions.set(parsed.instructionId, parsed);
    }
  }

  getInstruction(id: string): VicInstruction | undefined {
    const instruction = this.instructions.get(id);
    return instruction ? { ...instruction } : undefined;
  }
}

export interface MandateDispute {
  id: string;
  amount: number;
  currency: string;
  merchant?: string;
}

export interface MandateEvidenceResult {
  verified: boolean;
  reasons: string[];
  evidenceItem: EvidenceItem;
}

/**
 * Evaluate local instruction evidence against an already-verified TAP-style
 * signature and dispute. This creates a hash receipt, not a Visa-issued artifact.
 */
export function mandateEvidence(
  sig: TapVerificationResult,
  instruction: VicInstruction,
  dispute: Dispute | MandateDispute,
  now = new Date()
): MandateEvidenceResult {
  const parsed = instructionSchema.safeParse(instruction);
  const reasons: string[] = [];
  if (!sig.verified) reasons.push("request signature not verified");
  if (!parsed.success) {
    reasons.push("instruction is invalid");
  } else {
    const value = parsed.data;
    if (!value.userAuthenticated) reasons.push("user authentication missing");
    if (Date.parse(value.expiresAt) <= now.getTime()) reasons.push("instruction expired");
    if (dispute.amount > value.maxAmount) reasons.push("dispute amount exceeds instruction mandate");
    if (dispute.currency !== value.currency) reasons.push("currency does not match instruction mandate");
    if ("merchant" in dispute && dispute.merchant !== undefined && dispute.merchant !== value.merchant) reasons.push("merchant does not match instruction mandate");
  }
  const evidenceContent = JSON.stringify({
    instruction: parsed.success ? parsed.data : instruction,
    dispute: { id: dispute.id, amount: dispute.amount, currency: dispute.currency, merchant: "merchant" in dispute ? dispute.merchant ?? null : null },
    signature: { verified: sig.verified, authority: sig.authority ?? null, path: sig.path ?? null, keyId: sig.keyId ?? null, tag: sig.tag ?? null },
    reasons
  });
  const sha256 = createHash("sha256").update(evidenceContent, "utf8").digest("hex");
  const evidenceItem: EvidenceItem = { name: `vic-mandate-${instruction.instructionId}`, sha256, kind: "mandate" };
  return { verified: reasons.length === 0, reasons, evidenceItem };
}
