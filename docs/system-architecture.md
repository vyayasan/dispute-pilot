# System architecture

![System architecture diagram](./system-architecture.svg)

PNG export: [1-system-architecture.png](./1-system-architecture.png)

```mermaid
flowchart LR
  U[Reviewer] --> UI[Console page]
  UI -->|GET cases / approve / act / reject / reset| API[Console API]
  API -->|list / get / apply| GI[Gateway interface]
  API -->|approve / verify| AB[Approval binding<br/>HMAC issue + live checks]
  AB -->|fresh case read + legality| GI
  DM[Domain types + state machine<br/>Dispute · facts · evidence · stage/status] --> POL
  GI --> SIM[In-memory simulator<br/>default console backend]
  GI -. future adapter boundary .-> AW[Airwallex sandbox client<br/>typed client exists; not wired]
  API -->|facts + evidence + live state| POL[Policy + legal-action guard]
  POL -->|recommendation / legal actions| API
  EF[Evidence assembler<br/>CE 3.0 footprint + PDF/JPEG artifacts<br/>standalone helper; not simulator-wired]
  TAP[TAP-style RFC 9421 verifier] --> VIC[VIC-shaped fixture provider<br/>mandate checks + hash receipt]
  API -->|plan / review / action| AUD[Console timeline<br/>in-memory]
  SIM -->|per-case entries| LOG[Simulator case log<br/>in-memory; separate]
```

## What the code does

- The browser console presents the queue, server recommendation, evidence metadata and case timeline. The console API handles case reads, action approval, execution, reviewer rejection and demo reset.
- `Gateway` is declared in `src/sim/simGateway.ts`; the console defaults to that in-memory implementation. The separate `AirwallexClient` in `src/gateway/airwallex.ts` has typed sandbox reads and accept/challenge/simulation methods but is not plugged into the console's gateway interface.
- Policy scoring, policy thresholds and stage/status legality live in code. The API obtains case state through the gateway before approving or executing a response.
- Evidence assembly can make deterministic PDF/JPEG artifacts and hashes and checks the CE 3.0 prior-order footprint. The console simulator displays evidence metadata, not evidence file contents.
- TAP and VIC-shaped mandate verification are local helpers, separate from the current console flow. TAP binds a signed request and consumes a nonce; the fixture-backed instruction check emits an `EvidenceItem` hash receipt. The repository makes no claim of live Visa integration.
- Audit: `src/audit/audit.ts` is an append-only, hash-chained JSONL log (approval issued, refused, override, executed, outcome unknown, reset). The console timeline is the in-memory UI view of the same story.

```mermaid
flowchart TD
  A[GET /api/cases] --> B[Gateway list]
  B --> C[Policy decision + legal actions]
  C --> D[Console case view]
  D --> E{Reviewer choice}
  E -->|Approve action| F[POST /api/approve]
  F --> G[Signed, bounded approval]
  G --> H[POST /api/act]
  H --> I[Verify against current case]
  I -->|Pass| J[Gateway apply]
  I -->|Fail| K[409 refusal]
  D -->|Reject recommendation| L[POST /api/reject; no dispute action]
  J --> M[In-memory timeline]
  L --> M
```
