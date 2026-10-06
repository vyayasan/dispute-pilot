import { ceFootprintCheck, type EvidenceOrder } from "../src/evidence/assemble.js";

const disputed = {
  id: "disputed-order", createdAt: "2026-10-20T12:00:00.000Z", ip: "203.0.113.9",
  deviceId: "device-7", billingAddress: "1 Example Road", paymentMethod: "card-token-9",
};
const qualifyingOrder = (id: string, days: number, status = "undisputed"): EvidenceOrder => ({
  id, createdAt: new Date(Date.parse(disputed.createdAt) - days * 86_400_000).toISOString(), status,
  ip: disputed.ip, deviceId: disputed.deviceId, billingAddress: "other address", paymentMethod: "other-card",
});

export const ce3Checks = [
  { id: "ce3-two-eligible", orders: [qualifyingOrder("prior-a", 120), qualifyingOrder("prior-b", 365)], expected: true, why: "Both boundary-age orders qualify with two matching elements including IP/device." },
  { id: "ce3-only-one", orders: [qualifyingOrder("prior-a", 200)], expected: false, why: "CE 3.0 footprint requires at least two qualifying prior undisputed orders." },
  { id: "ce3-ineligible-age-status-match", orders: [qualifyingOrder("too-recent", 119), qualifyingOrder("too-old", 366), qualifyingOrder("disputed-status", 200, "disputed")], expected: false, why: "Orders outside 120-365 days or not undisputed/won/accepted do not count." },
  { id: "ce3-address-only", orders: [
    { ...qualifyingOrder("address-a", 180), ip: "different", deviceId: "different", billingAddress: disputed.billingAddress },
    { ...qualifyingOrder("address-b", 200), ip: "different", deviceId: "different", billingAddress: disputed.billingAddress },
  ], expected: false, why: "Matches must include IP or device; billing/payment-only overlap is insufficient." },
].map((item) => ({ ...item, disputed }));
