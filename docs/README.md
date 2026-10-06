# Dispute Pilot diagrams

Code-grounded workflow and architecture maps for the current repository. The Mermaid blocks render natively on GitHub; the paired SVG and PNG files are standalone diagram exports, not exports of dispute evidence.

## Diagrams

1. [System architecture](./system-architecture.md) · [SVG](./system-architecture.svg) · [PNG](./1-system-architecture.png)
2. [Dispute lifecycle](./dispute-lifecycle.md) · [SVG](./dispute-lifecycle.svg) · [PNG](./2-dispute-lifecycle.png)
3. [Approval binding](./approval-binding.md) · [SVG](./approval-binding.svg) · [PNG](./3-approval-binding.png)
4. [Kit 4 cases and mandate-evidence flip](./kit4-and-mandate.md) · [SVG](./kit4-and-mandate.svg) · [PNG](./4-kit4-and-mandate.png)

## Scope notes

- The console uses `makeSim()` by default and `LiveGateway` (`src/gateway/live.ts`, on the client in `src/gateway/airwallex.ts`) when Airwallex sandbox credentials are set in the environment. `LiveGateway` is covered by mocked-client tests and has not been run end to end through the console.
- `src/visa/tap.ts` is TAP-style RFC 9421 verification; `src/visa/vic.ts` uses a fixture-backed, VIC-shaped adapter. Neither is a live Visa integration.
- The console timeline is in memory; the hash-chained audit log (`src/audit/audit.ts`) is written to `audit.jsonl` by the server and can be verified with `verifyChain`.
- State-machine detail reflects `src/domain/stateMachine.ts` and `src/sim/simGateway.ts`; after an issuer rejection CHALLENGE is blocked and ESCALATE is legal at CHARGEBACK.
- In the mandate comparison, the code's policy sees whether the evidence list is empty, not a mandate-specific score. The comparison isolates that evidence-presence hinge; it is not a demonstrated end-to-end console integration. `mandateEvidence()` returns a hash receipt even for unverified results, with reasons; callers must check `verified` before considering it evidence.

## Re-render exports

The SVG/PNG pairs are generated from the adjacent Graphviz `.dot` sources. Run `./docs/render.sh` from the repository root with Graphviz (`dot`) installed. The Mermaid code in each page is kept alongside as the GitHub-rendered and portable source view.
