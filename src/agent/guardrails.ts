import type { Case } from "../sim/simGateway.js";
import type { Proposal } from "./planner.js";
import { CRITERIA } from "./rubric.js";

// Guardrails constrain what the model may say before anything else looks at it. Each check is plain code with a
// named reason. Any failure means the proposal is rejected and the policy decision stands.

export interface Violation { check: string; detail: string }

const CERTAINTY = /\b(guarantee[sd]?|certain(ly)? (to )?win|will (definitely |certainly )?win|cannot lose|100% (sure|certain)|no risk)\b/i;
const INSTRUCTION_LIKE = /\b(ignore (all |the |any )?(previous|prior|above|policy|rules)|disregard|system\s*:|you (must|should) (now )?(accept|refund|approve)|override)\b/i;

/** Every fact the model may rely on: the system-of-record case, serialised once. */
function allowedText(c: Case): string {
  return JSON.stringify({ d: c.dispute, f: c.facts, e: c.evidence.map((x) => x.name), s: c.story, docs: (c.documents ?? []).map((d) => d.text) }).toLowerCase();
}
const numbersIn = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));

export function checkGuardrails(p: Proposal, c: Case): { violations: Violation[]; warnings: string[] } {
  const v: Violation[] = [], warnings: string[] = [];
  const text = [p.rationale, p.challenge_narrative ?? "", ...CRITERIA.map((k) => p.rubric[k].note)].join("\n");
  const hay = allowedText(c).replace(/,/g, "");

  // 1. No new facts: every number the model writes must already be in the case record.
  const unknownNumbers = [...new Set(numbersIn(text))].filter((n) => !hay.includes(n));
  if (unknownNumbers.length) v.push({ check: "no_new_facts", detail: `numbers not found in the case record: ${unknownNumbers.slice(0, 5).join(", ")}` });

  // 2. No invented files: any file name mentioned must be one of this case's evidence files.
  const names = new Set(c.evidence.map((e) => e.name.toLowerCase()));
  const fileMentions = [...new Set((text.match(/[\w-]+\.(?:jpg|jpeg|pdf|png)\b/gi) ?? []).map((s) => s.toLowerCase()))].filter((n) => !names.has(n));
  if (fileMentions.length) v.push({ check: "no_new_facts", detail: `mentions evidence files the case does not have: ${fileMentions.slice(0, 3).join(", ")}` });

  // 3. Citations must point at something real: an evidence file or a structured fact key.
  const factKeys = new Set(Object.keys(c.facts)), valid = (x: string) => names.has(x.toLowerCase()) || factKeys.has(x);
  for (const k of CRITERIA) {
    const bad = p.rubric[k].cites.filter((x) => !valid(x));
    if (bad.length) v.push({ check: "citations", detail: `${k} cites things that are not in the case: ${bad.slice(0, 3).join(", ")}` });
  }

  // 4. Bounded tone: no promises about the outcome.
  if (CERTAINTY.test(text)) v.push({ check: "bounded_language", detail: "rationale promises an outcome" });

  // 5. No links anywhere in the output (the narrative is checked again by gate()).
  if (/https?:\/\/|www\./i.test(text)) v.push({ check: "no_links", detail: "output contains a link" });

  // Warning only: the case text tried to instruct the reader. The model is told to treat it as data, and it cannot
  // change the outcome anyway, but the reviewer should know.
  if ((c.documents ?? []).some((d) => INSTRUCTION_LIKE.test(d.text))) warnings.push("case text contains instruction-like wording; treated as data");
  return { violations: v, warnings };
}
