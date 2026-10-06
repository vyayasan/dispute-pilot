import { z } from "zod";
import { issue, ApprovalVerifier, type Approval } from "../approval/approval.js";
import { legalActions } from "../domain/stateMachine.js";
import type { Action, Dispute } from "../domain/types.js";
import { decide, DEFAULT_POLICY } from "../policy/policy.js";
import { makeSim, type Case, type Gateway } from "../sim/simGateway.js";
import { AuditLog } from "../audit/audit.js";

const ActBody = z.object({ approval: z.object({
  disputeId: z.string(), action: z.enum(["ACCEPT", "CHALLENGE", "ESCALATE"]), amount: z.number(), currency: z.string(),
  reasonCode: z.string(), stage: z.string(), status: z.string(), evidenceSha256: z.array(z.string()), policyVersion: z.string(),
  approver: z.string(), expiresAt: z.string(), nonce: z.string(), rationale: z.string().max(1024), sig: z.string(),
}) });
const ApproveBody = z.object({ disputeId: z.string(), action: z.enum(["ACCEPT", "CHALLENGE", "ESCALATE"]) });
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
  let timelineByCase = new Map<string, TimelineEvent[]>();

  const resetTimelines = () => {
    timelineByCase = new Map(gateway.list().map((c) => {
      const initial = decide(c.dispute, c.facts, c.evidence, DEFAULT_POLICY, now());
      return [c.dispute.id, [{ kind: "plan", title: "Initial plan", detail: `${initial.action}: ${initial.reasons.join("; ")}` }]];
    }));
  };
  resetTimelines();

  const view = (c: Case): CaseView => {
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
    if (url.pathname === "/api/cases" && request.method === "GET") return json({ cases: gateway.list().map(view), audit: audit.list() });
    if (url.pathname === "/api/reset-demo" && request.method === "POST") {
      gateway = makeSim(now()); resetTimelines(); audit.append("reset", {});
      return json({ cases: gateway.list().map(view) });
    }
    if (url.pathname === "/api/approve" && request.method === "POST") {
      const parsed = ApproveBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid approval request", 400);
      const c = gateway.get(parsed.data.disputeId);
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
      const c = gateway.get(approval.disputeId);
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
        const result = gateway.apply(c.dispute.id, approval.action);
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
    if (url.pathname === "/api/reject" && request.method === "POST") {
      const parsed = RejectBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return bad("invalid reject request", 400);
      const c = gateway.get(parsed.data.disputeId);
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
