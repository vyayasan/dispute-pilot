import { createHash } from "node:crypto";
import { z } from "zod";
import type { CaseFacts, EvidenceItem } from "../domain/types.js";
import { renderJpeg, renderPdf, type EvidenceArtifact } from "./render.js";

const Text = z.string().min(1).max(500);
const OrderSchema = z.object({
  id: Text,
  createdAt: z.string().min(1),
  status: z.string().min(1),
  ip: z.string().optional(),
  deviceId: z.string().optional(),
  billingAddress: z.string().optional(),
  paymentMethod: z.string().optional(),
});
const EmailSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  sentAt: z.string().optional(),
  body: z.string().optional(),
});
const ScanSchema = z.object({
  label: z.string().optional(),
  result: z.string().optional(),
  scannedAt: z.string().optional(),
  details: z.array(z.string()).optional(),
}).optional();

export type EvidenceOrder = z.infer<typeof OrderSchema>;
export type EvidenceEmail = z.infer<typeof EmailSchema>;
export type EvidenceScan = z.infer<typeof ScanSchema>;
export interface DisputedOrder extends Partial<EvidenceOrder> { createdAt: string; id?: string }

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const safe = (value: unknown) => String(value ?? "unknown").replace(/[\r\n\t]+/g, " ").slice(0, 500);
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface CeFootprintResult { ok: boolean; matched: string[]; reasons: string[] }

/**
 * CE 3.0 footprint: at least two prior undisputed orders, each 120-365 days
 * before the disputed order, with at least two of IP/device/address/payment
 * matching the disputed order. At least one match must be IP or device.
 */
export function ceFootprintCheck(orders: EvidenceOrder[], disputed: DisputedOrder): CeFootprintResult {
  const reasons: string[] = [];
  const disputedDate = Date.parse(disputed.createdAt);
  if (!Number.isFinite(disputedDate)) return { ok: false, matched: [], reasons: ["Disputed order has an invalid createdAt date."] };
  const d = disputed as EvidenceOrder;
  const eligible: string[] = [];
  for (const order of orders) {
    const orderDate = Date.parse(order.createdAt);
    if (!Number.isFinite(orderDate)) { reasons.push(`${order.id}: invalid order date.`); continue; }
    if (orderDate >= disputedDate) continue;
    if (!/^(undisputed|won|accepted)$/i.test(order.status)) continue;
    const ageDays = (disputedDate - orderDate) / 86_400_000;
    if (ageDays < 120 || ageDays > 365) continue;
    const matches = [
      ["ip", same(order.ip, d.ip)],
      ["device", same(order.deviceId, d.deviceId)],
      ["billing address", same(order.billingAddress, d.billingAddress)],
      ["payment method", same(order.paymentMethod, d.paymentMethod)],
    ] as const;
    const matchedFields = matches.filter(([, match]) => match).map(([field]) => field);
    if (matchedFields.length >= 2 && (matchedFields.includes("ip") || matchedFields.includes("device"))) eligible.push(order.id);
  }
  const matched = [...new Set(eligible)].sort();
  if (matched.length < 2) reasons.push(`Need 2 qualifying prior undisputed orders; found ${matched.length}.`);
  else reasons.push(`Found ${matched.length} qualifying prior undisputed orders (each 120-365 days old, 2+ matching elements including IP or device).`);
  return { ok: matched.length >= 2, matched, reasons };
}

/** Build deterministic, real PDF/JPEG artifacts and expose their EvidenceItem metadata. */
export async function assembleArtifacts(
  facts: CaseFacts,
  orders: EvidenceOrder[],
  emails: EvidenceEmail[],
  scan?: EvidenceScan,
  disputed: DisputedOrder = { createdAt: new Date(0).toISOString() },
): Promise<EvidenceArtifact[]> {
  const checkedOrders = z.array(OrderSchema).parse(orders);
  const checkedEmails = z.array(EmailSchema).parse(emails);
  const checkedScan = ScanSchema.parse(scan);
  const footprint = ceFootprintCheck(checkedOrders, disputed);
  const caseLines = [
    `Prior device and IP matches: ${facts.deviceIpMatchesPriorUndisputed}`,
    `Signed delivery: ${facts.signedDelivery === null ? "unknown" : facts.signedDelivery ? "yes" : "no"}`,
    `Unanswered support emails: ${facts.unansweredSupportEmails}`,
    `Prior undisputed footprint: ${footprint.ok ? "meets CE 3.0 check" : "does not meet CE 3.0 check"}`,
    ...footprint.reasons,
  ];
  const orderLines = [
    "CE 3.0 FOOTPRINT TABLE",
    "Prior undisputed order | Age | IP | Device | Billing address | Payment method | Qualifies",
    ...checkedOrders.map((order) => {
      const days = (Date.parse(disputed.createdAt) - Date.parse(order.createdAt)) / 86_400_000;
      const current = disputed as EvidenceOrder;
      const matches = [same(order.ip, current.ip), same(order.deviceId, current.deviceId), same(order.billingAddress, current.billingAddress), same(order.paymentMethod, current.paymentMethod)];
      const count = matches.filter(Boolean).length;
      const valid = /^(undisputed|won|accepted)$/i.test(order.status) && days >= 120 && days <= 365 && count >= 2 && (matches[0] || matches[1]);
      return `${order.id} | ${Number.isFinite(days) ? Math.floor(days) : "?"} days | ${matches[0] ? "Y" : "N"} | ${matches[1] ? "Y" : "N"} | ${matches[2] ? "Y" : "N"} | ${matches[3] ? "Y" : "N"} | ${valid ? "Y" : "N"}`;
    }),
    `Result: ${footprint.ok ? "PASS" : "FAIL"}`,
    ...footprint.reasons,
  ];
  const emailLines = checkedEmails.length ? checkedEmails.map((email, index) => `Email ${index + 1}: ${safe(email.sentAt)} | From ${safe(email.from)} | To ${safe(email.to)} | Subject ${safe(email.subject)} | ${safe(email.body)}`) : ["No support emails supplied."];
  const scanLines = checkedScan ? [
    `Label: ${safe(checkedScan.label)}`,
    `Result: ${safe(checkedScan.result)}`,
    `Scanned: ${safe(checkedScan.scannedAt)}`,
    ...(checkedScan.details ?? []),
  ] : ["No scan details supplied."];
  return [
    await renderPdf("case-summary.pdf", "Dispute case summary", caseLines),
    await renderPdf("ce-footprint.pdf", "CE 3.0 customer footprint", orderLines),
    await renderPdf("support-emails.pdf", "Customer support communications", emailLines),
    renderJpeg("scan-evidence.jpg", checkedScan?.label ?? "Scan evidence", scanLines),
  ];
}

export async function assemble(
  facts: CaseFacts,
  orders: EvidenceOrder[],
  emails: EvidenceEmail[],
  scan?: EvidenceScan,
  disputed?: DisputedOrder,
): Promise<EvidenceItem[]> {
  const artifacts = await assembleArtifacts(facts, orders, emails, scan, disputed);
  return artifacts.map(({ name, kind, bytes }) => ({ name, kind, sha256: digest(bytes) }));
}
