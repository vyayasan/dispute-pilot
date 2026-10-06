export type Stage = "PRE_CHARGEBACK" | "RFI" | "CHARGEBACK" | "PRE_ARBITRATION" | "ARBITRATION";
export type Status = "REQUIRES_RESPONSE" | "ESCALATED" | "ACCEPTED" | "CHALLENGED" | "WON" | "LOST" | "EXPIRED";
export type Action = "ACCEPT" | "CHALLENGE" | "ESCALATE";

export interface Dispute {
  id: string;
  amount: number; // major units
  currency: string;
  reasonCode: string; // e.g. "10.4"
  stage: Stage;
  status: Status;
  dueAt: string; // ISO
}

export interface EvidenceItem { name: string; sha256: string; kind: "jpg" | "pdf" | "mandate" }

export interface CaseFacts {
  deviceIpMatchesPriorUndisputed: number; // count of prior undisputed orders matching device + IP
  signedDelivery: boolean | null; // null = unknown
  unansweredSupportEmails: number;
  mandateVerified?: boolean; // false = agent purchase mandate failed verification (tampered, expired or out of scope)
  evidenceRejectedByBank?: boolean; // issuer rejected a prior challenge: only one shot, a person decides
}
