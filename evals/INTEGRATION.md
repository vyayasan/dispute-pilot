# Integration

This pack is intended to be overlaid at the root of the public `dispute-pilot` repository. It adds `evals/` and the `"evals": "tsx evals/runner.ts"` package script to the existing `package.json`. Dependencies already in the repo provide `tsx`, Vitest, and the policy source under `src/`.

Run `npm run evals` to regenerate `evals/RESULTS.md` and print the scorecard. Run `npx vitest run evals/scenarios.test.ts` for the Vitest-compatible checks. The expected five policy mismatches are deliberate regression/security signals and make both commands exit nonzero.
