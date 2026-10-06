# Dispute Pilot adversarial review

Review basis: public repository at `vyayasan/dispute-pilot`, cloned read-only on 2026-10-05. Scope reviewed: approval issuance/verification, console API/server/browser boundary, simulator/gateway request IDs, TAP-style verification/replay handling, and evidence output. No production credentials or live payment endpoint were used. The repo is a local simulator/demo; findings about a deployable service are marked accordingly.

## Baseline and added tests

- Initial `npm install && npm test`: **57/57 passing** (7 files).
- With added red-team tests: **67/67 passing** (11 files).
- `npm run typecheck`: passing.
- `npm audit --omit=dev`: no production dependency advisories reported. Full `npm audit` reported 5 advisories in dev tooling: 1 critical, 1 high, 3 moderate, in Vitest/Vite/esbuild-related packages; npm proposed Vitest 5.0.3 as a fix (major update from the configured Vitest 2 line). They do not affect the production dependency graph, but CI/test environments should upgrade and revalidate. This review did not attempt the major upgrade.
- No changes were made to application source. Added tests are regression demonstrations, including deliberately passing tests that document behavior/risk rather than assert a fix.

## Findings (severity ranked)

### High - Local console has no caller authentication and trusts the browser for the human approval step

`src/console/api.ts` exposes `/api/approve` to any caller that can reach the server. It accepts any legal action for a dispute and signs an approval itself; `/api/act` then accepts that approval from the request body. The HMAC check is real and stops a caller from editing a token, but it does not establish that a human reviewed it: an unauthenticated caller can ask `/api/approve` to mint a valid token and immediately submit it to `/api/act`. `/api/approve` does not enforce the policy recommendation either; it only checks legal state. `/api/reset-demo` is similarly unauthenticated and resets the verifier/replay ledger.

`src/console/server.ts` listens on port 3000 without specifying a loopback host, and the handler does not validate `Origin`/`Host` or use a CSRF token. The test shows that the API handler accepts foreign `Origin` values. A conventional cross-origin JSON `fetch` ordinarily needs a successful preflight, which this server does not provide; do not overstate this as a demonstrated ordinary CSRF exploit. DNS rebinding or another same-origin route to the listener is a relevant concern because origin/host binding is absent. Network reachability depends on the deployment environment.

**Assessment:** acceptable only as an explicitly local, disposable demo with no real actions or sensitive data. Must fix before exposing beyond a developer's loopback machine or connecting a real gateway: bind loopback by default, require an authenticated reviewer/session and CSRF/origin defenses, gate reset, and make the human authorization server-verifiable. The current UI click is not a security boundary.

Regression demonstrations: `console.redteam.test.ts` (foreign Origin accepted for mint+act, reset revives an approval).

### High - Approval remains reusable when a gateway call errors after an ambiguous remote commit

`/api/act` calls `gateway.apply(...)` and only then calls `verifier.consume(approval)`. If an upstream mutation committed but its response was lost or an exception was raised after commit, the request returns an error without consuming the nonce. A retry passes signature, expiry, live-state (if the provider has not yet reflected the mutation), and unused-nonce checks, then submits a second mutation. The injected test gateway models this ambiguous outcome and demonstrates a second call is permitted.

The in-repo `Gateway.apply` is synchronous and the simulator is deterministic, so the precise network ambiguity is a production-adapter concern, not a reproduced failure against the simulator. The ordering is still unsafe for a real remote gateway. Consuming before the call alone is also insufficient because a timeout could leave the user unable to learn/resolve the outcome; use durable action state/idempotency, reserve/consume atomically, and reconcile ambiguous outcomes.

**Assessment:** demo-only gateway: low immediate impact. Before real dispute mutations: must fix with durable idempotency keyed to approval/action and an explicit pending/unknown outcome that cannot blindly replay.

Regression demonstration: `console.redteam.test.ts` (first gateway call throws after simulated commit, second use reaches gateway again).

### Medium - Mutation retries receive a new `request_id`

`AirwallexClient.call()` generates a fresh UUID for every POST invocation. A retry by the caller after a transport timeout therefore sends a different request ID, defeating provider-side idempotency for the same logical action. The client itself currently does not retry; this becomes important whenever retry logic is added or a caller manually retries after an ambiguous result. The test establishes that repeated logical invocation creates different IDs.

**Assessment:** not an immediate bug in the current client absent automatic retries, but must be addressed before retrying/production use. Derive/store one stable request ID per approval/action attempt and persist it across retries; do not generate per network attempt.

Regression demonstration: `gateway.redteam.test.ts`.

### Low - Approval replay ledger grows for the lifetime of the process

`ApprovalVerifier.used` is a `Set` and `consume` never removes entries. Every executed approval grows this set until process restart/reset. It has no direct authorization bypass, but sustained operation can grow memory without bound. It is process-local, so a restart also loses replay history; multiple instances would not share single-use enforcement.

**Assessment:** acceptable for a short-lived demo. Use a bounded TTL-backed durable/shared replay store (expiry is signed) before a persistent or multi-instance service.

Regression demonstration: `approval-store.redteam.test.ts` records expired approvals and confirms entries remain.

### Low / deployment policy - TAP replay store and clock assumptions

The TAP nonce store prunes expired entries on each consume; accepted signatures have a default maximum lifetime of 300 seconds, so this is not an indefinitely growing store under default policy. It is process-local and explicitly documented as demo-only: multiple workers or restarts can accept a replay unless production injects a shared atomic store. Default clock skew is zero, which can reject otherwise valid requests from slightly skewed peers; explicitly configure a justified skew and synchronize clocks if this verifier is deployed.

The verifier binds `alg` to the registered key's algorithm and rejects mismatches; review did not find an Ed25519/RSA-PSS downgrade. Added regression test records this rejection.

### Informational - Checked items that held up

- `/api/act` obtains the current case from `gateway.get` and checks the signed dispute fields, evidence hashes, legal action, and expiry against that live object. It is not merely trusting the browser's approval object. It does not re-read state after the external mutation begins, which is the separate ambiguous-commit issue above.
- Approval HMAC signature validation and nonce replay refusal work in the tested single-process happy path. `/api/approve` itself is not evidence of human approval (High finding).
- TAP-style verifier rejects algorithm/key-record mismatch; no downgrade found in the scoped implementation.
- Evidence uses only `pdf`, `jpg`, or `mandate` metadata, renderer creates PDF/JPEG, and the evidence test checks JPEG magic and absence of PNG magic. I found no PNG output or leak in the reviewed UI/renderer path. The console renders evidence metadata only; it does not serve the generated artifact bytes.

## Added files

- `test/redteam/console.redteam.test.ts`
- `test/redteam/gateway.redteam.test.ts`
- `test/redteam/tap.redteam.test.ts`
- `test/redteam/approval-store.redteam.test.ts`

Tests intentionally document both protections and present gaps. The check of the approval Set uses internal state to demonstrate retention, so refactor that test if the implementation adopts an explicit store interface.

## Platform and model review (October 2026)

A second pass from two angles: someone who runs the Airwallex disputes API in production, and someone who builds on the Claude API. Checked against the current Airwallex docs and the Claude platform docs. Severity is for a production deployment, not the demo.

### Fixed in this pass
| Severity | Finding | Fix |
|---|---|---|
| High | The default model id was out of date, and the request forced a tool call (`tool_choice: any`). The current Sonnet model returns a 400 for forced tool use, so the planner would have failed on every call and fallen back to policy. | Default is now `claude-sonnet-5-5` (override with `ANTHROPIC_MODEL`). The request uses `tool_choice: auto`, the prompt says to answer by tool call, the planner nudges once if the model answers in prose, then fails closed. |
| Medium | `max_tokens` was 1500, which adaptive thinking also draws from, so a rubric-sized answer could be cut off. | Raised to 4096. Truncated output fails schema validation and falls back to policy. |
| High | The Airwallex client did not recover from an expired token (401) or a rate limit (429). | One re-login on 401. Up to two backoff retries on 429, reusing the same `request_id` so Airwallex deduplicates the call. Tested. |
| High | Disputes were only read by polling. Airwallex sends `payment_dispute.*` webhooks (requires_response, challenged, accepted, expired, pending_closure, pending_decision, won, lost, reversed). | Added `src/gateway/webhook.ts`: HMAC-SHA256 check of timestamp + raw body, timestamp tolerance, constant-time compare, duplicate drop by event id. Tested. |

### Open, documented
| Severity | Finding | Note |
|---|---|---|
| High | `LiveGateway` has only been run against mocks through the console. The raw sandbox run in `RUNLOG.md` used the client directly. | Needs one end-to-end console run on the sandbox. |
| High | The webhook verifier is not wired to a public endpoint. The console binds to loopback by design. | Production needs a small public ingress that calls `WebhookVerifier` and then reloads the dispute. |
| High | Approval is a local click without real authentication, and the replay store is in memory (see above). | Production needs SSO and a persistent nonce store. |
| Medium | The order facts the agent decides on (device and IP history, delivery proof, support threads) come from fixtures. `factsFor` and `challengeFor` are caller-supplied. | Production needs an order-system integration. |
| Medium | The dispute fee is configured in policy code; the sandbox does not deduct it. The low-value accept threshold is a configured constant. | Read both from the merchant's real settings. |
| Medium | `listDisputes` asks for 100 per page and reads one page. | A merchant with more open disputes needs a paging loop. |
| Medium | The governance layers are tested with a mock model and scripted proposals. No live run, so the real rate at which guardrails reject a live model is unknown. Weights and bands are demo values. | Run the 3 demo cases and the red-team set on a live model and record the trip rates. |
| Low | Strict tool use (`strict: true`) is not enabled. Zod validates every proposal in code instead, and failures fall back to policy. | Revisit once the schema subset is confirmed for the integer score bounds. |
| Low | No usage or cost logging for model calls; no retry on model 429 or 529 (the case simply falls back to policy). | Add if the model layer is used at volume. |
| Low | The critic is available (`modelCritic`) but off by default. | Turn it on for high-value cases. |
