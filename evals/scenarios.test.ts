import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, decide } from "../src/policy/policy.js";
import { ceFootprintCheck } from "../src/evidence/assemble.js";
import { ce3Checks } from "./ce3.js";
import { evalNow, scenarios } from "./scenarios.js";

describe("dispute policy eval scenarios", () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.summary}`, () => {
      const result = decide(scenario.dispute, scenario.facts, scenario.evidence, DEFAULT_POLICY, evalNow);
      expect(result.action, scenario.why).toBe(scenario.expected);
    });
  }
});
describe("CE 3.0 evidence footprint", () => {
  for (const check of ce3Checks) {
    it(`${check.id}: ${check.why}`, () => expect(ceFootprintCheck(check.orders, check.disputed).ok).toBe(check.expected));
  }
});
