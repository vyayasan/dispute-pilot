# Dispute policy eval pack

Run from the repository root with `npm run evals`. Vitest-compatible scenarios are in `evals/scenarios.test.ts` and can run with `npx vitest run evals/scenarios.test.ts`. The standalone runner uses a fixed clock, fixed evidence hashes, and the actual `src/policy/policy.js` decision function. It makes no network calls and uses no secrets.

The corpus broadens beyond the three README demos: Visa 10.x/11.x/12.x/13.x and Mastercard reason-code examples, CE 3.0 footprints/edge cases, mandate-verification boundaries, economics represented in GBP/EUR/USD/SGD/HKD, deadline limits, evidence gaps, and malformed/adversarial fields. Case labels are scenario context, not a representation that the current policy implements each scheme's full reason-code rules. The current engine only assigns special win-probability logic to Visa 10.4 and 13.1; other codes exercise conservative baseline behavior.

`securityExpectation` fixtures encode fail-closed requirements for invalid money/currency inputs. Current engine behavior is reported as failing rather than hidden. The current policy's fee and autonomy cap are nominal single-currency values; these tests document its behavior only and do not imply FX conversion or that fee economics are correct in every currency. Mandate evidence currently affects only evidence presence, not win probability or validity. A verified or tampered mandate must be verified upstream and filtered by its caller; the tampered-mandate scenario documents this integration gap.

A pass means the policy returned the specified action for a synthetic scenario. It is not scheme certification, legal advice, or evidence that a live PSP/issuer would decide the same way.
