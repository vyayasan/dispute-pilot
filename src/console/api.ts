import { z } from "zod";
import { createHash } from "node:crypto";
import { issue, ApprovalVerifier, type Approval } from "../approval/approval.js";
import { legalActions } from "../domain/stateMachine.js";
import type { Action, Dispute } from "../domain/types.js";
import { decide, DEFAULT_POLICY } from "../policy/policy.js";
import { makeSim, type Case, type Gateway } from "../sim/simGateway.js";
import { AuditLog } from "../audit/audit.js";
import type { PlanResult } from "../agent/planner.js";

const ActBody = z.object({ approval: z.object({
  disputeId: z.string(), action: z.enum(["ACCEPT", "CHALLENGE", "ESCALATE"]), amount: z.number(), currency: z.string(),
  reasonCode: z.string(), stage: z.string(), status: z.string(), evidenceSha256: z.array(z.string()), policyVersion: z.string(),
  approver: z.string(), expiresAt: z.string(), nonce: z.string(), rationale: z.string().max(1024), sig: z.string(),
}) });
const PlanBody = z.object({ disputeId: z.string() });
const ApproveBody = z.object({ disputeId: z.string(), action: z.enum(["ACCEPT", "CHALLENGE", "ESCALATE"]) });
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const EvidenceBody = z.object({ disputeId: z.string(), name: z.string().trim().min(1).max(120).regex(/^[\w .()-]+$/), kind: z.enum(["jpg", "pdf"]), base64: z.string().max(8 * 1024 * 1024) });
const RejectBody = z.object({ disputeId: z.string(), reason: z.string().trim().min(1).max(1024) }); // a rejection must say why

export interface TimelineEvent { kind: "plan" | "new-info" | "revised-decision" | "review" | "action"; title: string; detail: string }
export interface CaseView {
  dispute: Dispute;
  facts: Case["facts"];
  evidence: Case["evidence"];
  story: string;
  decision: ReturnType<typeof decide>;
  legalActions: Action[];
  timeline: TimelineEvent[];
}

export interface ConsoleApiOptions {
  gateway?: Gateway;
  /** Factory used on demo reset so a live console stays live; defaults to the simulator. */
  makeGateway?: () => Gateway;
  /** Optional model-backed planner. It proposes and explains; it has no way to approve or execute. */
  planner?: (c: Case) => Promise<PlanResult>;
  key?: string;
  approver?: string;
  now?: () => Date;
  audit?: AuditLog;
  /** When set, every POST must carry this value in x-console-token (the page gets it from the server). */
  sessionToken?: string;
  /** When set, a request with an Origin header must match one of these. */
  allowedOrigins?: string[];
}

/** A fetch-compatible API handler. In production this handler belongs on the server. */
export function createConsoleApi(options: ConsoleApiOptions = {}) {
  const key = options.key ?? "local-demo-signing-key-change-before-deploy-32";
  const approver = options.approver ?? "demo-reviewer";
  const now = options.now ?? (() => new Date());
  let gateway = options.gateway ?? makeSim(now());
  // One verifier for the life of the process: a demo reset must not revive an already used approval.
  const verifier = new ApprovalVerifier(key);
  const audit = options.audit ?? new AuditLog();
  const timelineByCase = new Map<string, TimelineEvent[]>();
  // The gateway may be remote, so the opening plan is written the first time a case is seen.
  const seed = (c: Case) => {
    if (timelineByCase.has(c.dispute.id)) return;
    const initial = decide(c.dispute, c.facts, c.evidence, DEFAULT_POLICY, now());
    timelineByCase.set(c.dispute.id, [{ kind: "plan", title: "Initial plan", detail: `${initial.action}: ${initial.reasons.join("; ")}` }]);
  };

  const view = (c: Case): CaseView => {
    seed(c);
    const decision = decide(c.dispute, c.facts, c.evidence, DEFAULT_POLICY, now());
    return { dispute: c.dispute, facts: c.facts, evidence: c.evidence, story: c.story, decision,
      legalActions: legalActions(c.dispute, c.facts), timeline: [...(timelineByCase.get(c.dispute.id) ?? [])] };
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const bad = (message: string, status: number) => json({ error: message }, status);

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST") {
      const origin = request.headers.get("origin");
      if (options.allowedOrigins && origin && !options.allowedOrigins.includes(origin)) { audit.append("refused", { reason: "origin not allowed", origin }); return bad("origin not allowed", 403); }
      if (options.sessionToken && request.headers.get("x-console-token") !== options.sessionToken) { audit.append("refused", { reason: "missing or wrong console token", path: url.pathname }); return bad("missing or wrong console token", 403); }
    }
    if (url.pathname === "/api/cases" && request.method === "GET") return json({ cases: (await gateway.list()).map(view), audit: audit.list() });
    if (url.pathname === "/api/reset-demo" && request.method === "POST") {
      gateway = (options.makeGateway ?? (() => makeSim(now())))(); timelineByCase.clear(); audit.append("reset", {});
      return json({ cases: (await gateway.list()).map(view) });
    }
    if (url.pathname === "/api/approve" && request.method === "POST") {
      const parsed = ApproveBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid approval request", 400);
      const c = await gateway.get(parsed.data.disputeId);
      if (!c) return bad("dispute not found", 404);
      if (!legalActions(c.dispute, c.facts).includes(parsed.data.action)) return bad("action not legal in live state", 409);
      const approval: Approval = issue(c.dispute, parsed.data.action, c.evidence.map((e) => e.sha256), DEFAULT_POLICY.version,
        approver, key, 60_000, now(), `Agent recommends ${decide(c.dispute, c.facts, c.evidence, DEFAULT_POLICY, now()).action}: ${decide(c.dispute, c.facts, c.evidence, DEFAULT_POLICY, now()).reasons.join("; ")}`);
      audit.append("approval_issued", { action: approval.action, amount: approval.amount, currency: approval.currency, reasonCode: approval.reasonCode, nonce: approval.nonce }, c.dispute.id);
      return json({ approval });
    }
    if (url.pathname === "/api/act" && request.method === "POST") {
      const parsed = ActBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid action request", 400);
      const approval = parsed.data.approval as Approval;
      const c = await gateway.get(approval.disputeId);
      if (!c) return bad("dispute not found", 404);
      const refusal = verifier.check(approval, c.dispute, approval.action, c.evidence.map((e) => e.sha256), now(), c.facts);
      if (refusal) { audit.append("refused", { action: approval.action, reason: refusal, nonce: approval.nonce }, c.dispute.id); return bad(refusal, 409); }
      // Consume BEFORE the gateway call: if the call errors after an ambiguous remote commit, a blind retry must not double-submit.
      verifier.consume(approval);
      const recommended = decide(c.dispute, c.facts, c.evidence, DEFAULT_POLICY, now());
      const history = timelineByCase.get(c.dispute.id) ?? [];
      const override = recommended.action !== approval.action;
      if (override) {
        const detail = `Reviewer chose ${approval.action} against the recommendation (${recommended.action}).`;
        history.push({ kind: "review", title: "Override", detail });
        audit.append("override", { chosen: approval.action, recommended: recommended.action, reasons: recommended.reasons }, c.dispute.id);
      }
      try {
        const result = await gateway.apply(c.dispute.id, approval.action);
        audit.append("executed", { action: approval.action, amount: approval.amount, currency: approval.currency, reasonCode: approval.reasonCode, result, nonce: approval.nonce }, c.dispute.id);
        if (result.includes("issuer rejected")) {
          history.push({ kind: "new-info", title: "New information", detail: result });
          const revised = decide(c.dispute, c.facts, c.evidence, DEFAULT_POLICY, now());
          history.push({ kind: "revised-decision", title: "Revised decision", detail: `${revised.action}: ${revised.reasons.join("; ")}` });
        } else {
          history.push({ kind: "action", title: "Action recorded", detail: result });
        }
        timelineByCase.set(c.dispute.id, history);
        return json({ result, case: view(c) });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "action failed";
        history.push({ kind: "review", title: "Outcome unknown", detail: "The action may or may not have gone through. Reconcile against the live dispute before approving again." });
        timelineByCase.set(c.dispute.id, history);
        audit.append("outcome_unknown", { action: approval.action, error: msg, nonce: approval.nonce }, c.dispute.id);
        return bad(`outcome unknown, reconcile before retrying: ${msg}`, 409);
      }
    }
    if (url.pathname === "/api/plan" && request.method === "POST") {
      if (!options.planner) return bad("no model configured: the policy decision above is the plan", 501);
      const parsed = PlanBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid plan request", 400);
      const c = await gateway.get(parsed.data.disputeId);
      if (!c) return bad("dispute not found", 404);
      const plan = await options.planner(c);
      if (!plan.ok) audit.append("model_error", { error: plan.error }, c.dispute.id);
      else audit.append(plan.gate?.accepted ? "model_proposal" : "model_proposal_rejected", {
        proposed: plan.proposal?.action, confidence: plan.proposal?.confidence, finalAction: plan.gate?.finalAction, reasons: plan.gate?.reasons,
        rationale: plan.proposal?.rationale.slice(0, 300), narrativeSha256: plan.narrativeSha256, cited: plan.proposal?.cited_evidence,
        governance: plan.gate?.governance ? { rubricTotal: plan.gate.governance.rubric?.total, band: plan.gate.governance.rubric?.band, adjustedWinProbability: plan.gate.governance.rubric?.adjustedWinProbability, guardrails: plan.gate.governance.guardrailViolations.map((x) => x.check), reasoning: plan.gate.governance.reasoningViolations.map((x) => x.check), warnings: plan.gate.governance.warnings, critic: plan.gate.governance.critic?.veto } : undefined,
      }, c.dispute.id);
      seed(c);
      (timelineByCase.get(c.dispute.id) ?? []).push({ kind: "plan", title: plan.ok ? (plan.gate?.accepted ? "Model proposal accepted by policy" : "Model proposal rejected by policy") : "Model unavailable",
        detail: plan.ok ? `Proposed ${plan.proposal?.action}. ${plan.gate?.reasons.join("; ")}` : `${plan.error}. Policy decision stands.` });
      return json({ plan, case: view(c) });
    }
    if (url.pathname === "/api/evidence" && request.method === "POST") {
      const parsed = EvidenceBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid evidence upload", 400);
      const c = await gateway.get(parsed.data.disputeId);
      if (!c) return bad("dispute not found", 404);
      if (!gateway.attachEvidence) return bad("this gateway does not accept evidence uploads", 501);
      const bytes = Buffer.from(parsed.data.base64, "base64");
      if (bytes.length === 0 || bytes.length > MAX_EVIDENCE_BYTES) return bad("evidence must be 1 byte to 5 MB", 413);
      const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8, isPdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
      // Airwallex takes JPG or PDF only; check the bytes, not the name the caller gave.
      if (!(parsed.data.kind === "jpg" ? isJpg : isPdf)) { audit.append("refused", { reason: "evidence bytes do not match declared type", kind: parsed.data.kind }, c.dispute.id); return bad("file content does not match its declared type (JPG or PDF only)", 415); }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const item = await gateway.attachEvidence(c.dispute.id, { name: parsed.data.name, kind: parsed.data.kind, bytes, sha256 });
      audit.append("evidence_added", { name: item.name, kind: item.kind, sha256: item.sha256, bytes: bytes.length }, c.dispute.id);
      seed(c);
      (timelineByCase.get(c.dispute.id) ?? []).push({ kind: "new-info", title: "Evidence added", detail: `${item.name} (${item.kind}). Any earlier approval no longer matches and must be re-issued.` });
      return json({ case: view(c) });
    }
    if (url.pathname === "/api/reject" && request.method === "POST") {
      const parsed = RejectBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid reject request", 400);
      const c = await gateway.get(parsed.data.disputeId);
      if (!c) return bad("dispute not found", 404);
      c.log.push("Reviewer rejected the recommendation; no dispute action was submitted.");
      audit.append("recommendation_rejected", { reason: parsed.data.reason }, c.dispute.id);
      const history = timelineByCase.get(c.dispute.id) ?? [];
      history.push({ kind: "review", title: "Reviewer rejected the recommendation", detail: `Reason: ${parsed.data.reason}. No dispute action was submitted.` });
      timelineByCase.set(c.dispute.id, history);
      return json({ case: view(c) });
    }
    return bad("not found", 404);
  };
}
