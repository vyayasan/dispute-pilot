import { createHmac, timingSafeEqual } from "node:crypto";

// Verifies an Airwallex webhook delivery. The signature is the hex HMAC-SHA256 of x-timestamp + the raw request body,
// keyed with the webhook secret. Delivery is at least once, so the event id is used to drop repeats.
// This is a library: the console binds to loopback only, so a public ingress would have to be added by the operator.

export const DISPUTE_EVENTS = [
  "payment_dispute.requires_response", "payment_dispute.challenged", "payment_dispute.accepted", "payment_dispute.expired",
  "payment_dispute.pending_closure", "payment_dispute.pending_decision", "payment_dispute.won", "payment_dispute.lost", "payment_dispute.reversed",
] as const;

export interface WebhookEvent { id: string; name: string; data: any }

export class WebhookVerifier {
  private seen = new Map<string, number>();
  constructor(private secret: string, private opts: { toleranceMs?: number; now?: () => number; maxRemembered?: number } = {}) {
    if (!secret) throw new Error("a webhook secret is required");
  }
  /** Returns the event, "duplicate" for a repeat delivery, or throws on a bad signature or stale timestamp. */
  verify(rawBody: string, headers: { timestamp?: string | null; signature?: string | null }): WebhookEvent | "duplicate" {
    const now = (this.opts.now ?? Date.now)(), tol = this.opts.toleranceMs ?? 5 * 60_000;
    const ts = headers.timestamp ?? "", sig = headers.signature ?? "";
    if (!/^\d{10,16}$/.test(ts) || !sig) throw new Error("missing or malformed webhook headers");
    if (Math.abs(now - Number(ts)) > tol) throw new Error("webhook timestamp outside tolerance");
    const want = createHmac("sha256", this.secret).update(ts + rawBody).digest();
    const got = Buffer.from(sig, "hex");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("webhook signature mismatch");
    let j: any; try { j = JSON.parse(rawBody); } catch { throw new Error("webhook body is not JSON"); }
    if (typeof j?.id !== "string" || typeof j?.name !== "string") throw new Error("webhook body is not an event");
    if (this.seen.has(j.id)) return "duplicate";
    this.seen.set(j.id, now);
    const max = this.opts.maxRemembered ?? 5000;
    if (this.seen.size > max) this.seen.delete(this.seen.keys().next().value as string);
    return { id: j.id, name: j.name, data: j.data };
  }
}

/** Dispute events mean "reload this dispute"; the live record, not the payload, is what the agent decides on. */
export const isDisputeEvent = (e: WebhookEvent) => (DISPUTE_EVENTS as readonly string[]).includes(e.name);
