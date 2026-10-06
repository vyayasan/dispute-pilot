// Case intake: how dispute material reaches the agent in production. Nobody copy-pastes in the real flow -
// the case arrives from wherever the dispute ecosystem puts it: the Airwallex dispute webhook, a customer
// email, an evidence file uploaded in the console, or the issuer's chargeback letter as a PDF. Every path
// produces the same thing: untrusted text plus a provenance string for the audit log. The policy, model and
// governance layers downstream do not care which path the material took - case text stays untrusted data.

export type IntakeSource = "dispute-webhook" | "customer-email" | "evidence-upload" | "issuer-letter-pdf";
export interface IntakeResult { ok: boolean; text?: string; provenance?: string; error?: string }

const MAX_TEXT_CHARS = 20_000;
const clean = (text: string): string | undefined => {
  const t = text.replace(/[\x00-\x1f]+/g, " ").trim();
  return t.length > 0 && t.length <= MAX_TEXT_CHARS ? t : undefined;
};
const fail = (error: string): IntakeResult => ({ ok: false, error });

/** Dispute webhook (Airwallex-shaped): a dispute event means the case itself has arrived - id, amount,
 * currency and reason code come from the payload, not from anyone retyping a dashboard. */
export function fromDisputeWebhook(payload: { event: string; data?: { id?: string; amount?: number; currency?: string; reason_code?: string } }): IntakeResult {
  const d = payload.data;
  if (!payload.event.startsWith("dispute.")) return fail(`unexpected event "${payload.event}"`);
  if (!d?.id || d.amount == null || !d.currency || !d.reason_code) return fail("dispute payload is missing id, amount, currency or reason_code");
  return {
    ok: true,
    text: `Dispute ${d.id}: ${d.amount} ${d.currency}, reason code ${d.reason_code} (event ${payload.event})`,
    provenance: `Airwallex webhook ${payload.event} for ${d.id} at ${new Date().toISOString()}`,
  };
}

/** A customer email (reply to the dispute, a support thread). The text is untrusted case material. */
export function fromCustomerEmail(mail: { from: string; subject: string; text: string; receivedAt?: string }): IntakeResult {
  const text = clean(mail.text);
  return text
    ? { ok: true, text, provenance: `customer email from ${mail.from} ("${mail.subject.slice(0, 80)}") at ${mail.receivedAt ?? new Date().toISOString()}` }
    : fail("email had no usable text");
}

/** An evidence file dropped into the console (delivery scan, order record). JPG or PDF, checked by file
 * signature - the same check as POST /api/evidence. The bytes go to evidence storage; the case record gets
 * the metadata and provenance. */
export function fromEvidenceUpload(filename: string, bytes: Uint8Array, at: Date = new Date()): IntakeResult {
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d; // "%PDF-"
  if (!isJpg && !isPdf) return fail(`evidence file ${filename} is neither JPG nor PDF by signature`);
  const kind = isJpg ? "image/jpeg" : "application/pdf";
  return { ok: true, text: `evidence file ${filename} (${kind}, ${bytes.length} bytes)`, provenance: `evidence upload ${filename} at ${at.toISOString()}` };
}

/** The issuer's chargeback letter as a PDF. Text extraction is pluggable: hosts bring their own extractor
 * (OCR for scans, a text-layer reader for digital PDFs). Without one the path fails closed and says so. */
export type PdfExtractor = (bytes: Uint8Array, filename: string) => Promise<string>;
export async function fromIssuerLetterPdf(filename: string, bytes: Uint8Array, extractor?: PdfExtractor, at: Date = new Date()): Promise<IntakeResult> {
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  if (!isPdf) return fail(`${filename} is not a PDF by signature`);
  if (!extractor) return fail("no PDF extractor configured: bring an OCR or text-layer reader for this path");
  const text = clean(await extractor(bytes, filename));
  return text ? { ok: true, text, provenance: `issuer letter PDF ${filename} at ${at.toISOString()}` } : fail("issuer letter produced no usable text");
}
