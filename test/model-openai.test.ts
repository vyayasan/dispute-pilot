import { describe, it, expect } from "vitest";
import { OpenAICompatibleModel, modelFromEnv } from "../src/agent/model.js";
import { planCase } from "../src/agent/planner.js";
import { makeSim, type Case } from "../src/sim/simGateway.js";

const NOW = new Date();
const fraudCase = (): Case => makeSim(NOW).get("dsp_demo_fraud")!;
const sc = (score: number, cites: string[] = []) => ({ score, cites, note: "per the case record" });

/** A fetch stub that plays an OpenAI-compatible server and records what it was sent. */
function fakeServer(replies: unknown[]) {
  const seen: unknown[] = [];
  const fetchImpl = async (_url: unknown, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const readCaseReply = { choices: [{ message: { role: "assistant", content: null, tool_calls: [
  { id: "call_1", type: "function", function: { name: "read_case", arguments: JSON.stringify({ dispute_id: "dsp_demo_fraud" }) } },
] } } ] };

const proposal = {
  action: "CHALLENGE", confidence: 0.8,
  rationale: "Signed delivery on file and the device matches prior undisputed orders.",
  challenge_narrative: "Delivery was signed for; the footprint matches earlier orders.",
  cited_evidence: ["delivery-signature.jpg"],
  rubric: { evidence_strength: sc(5, ["delivery-signature.jpg"]), customer_history: sc(4, ["unansweredSupportEmails"]), narrative_consistency: sc(4, ["order-footprint.pdf"]), reason_code_fit: sc(5, ["signedDelivery"]) },
};
const proposeReply = { choices: [{ message: { role: "assistant", content: null, tool_calls: [
  { id: "call_2", type: "function", function: { name: "propose_action", arguments: JSON.stringify(proposal) } },
] } } ] };

describe("OpenAICompatibleModel", () => {
  it("requires a base URL and a model", () => {
    expect(() => new OpenAICompatibleModel({ baseUrl: "", model: "x" })).toThrow();
    expect(() => new OpenAICompatibleModel({ baseUrl: "http://x", model: "" })).toThrow();
  });

  it("modelFromEnv prefers Anthropic, then any OpenAI-compatible endpoint, else off", () => {
    expect(modelFromEnv({})).toBeUndefined();
    expect(modelFromEnv({ EXTRACTION_BASE_URL: "http://x", EXTRACTION_MODEL: "m" })?.constructor.name).toBe("OpenAICompatibleModel");
    expect(modelFromEnv({ ANTHROPIC_API_KEY: "k", EXTRACTION_BASE_URL: "http://x", EXTRACTION_MODEL: "m" })?.constructor.name).toBe("AnthropicModel");
  });

  it("translates tools and tool_use blocks to and from the OpenAI shape", async () => {
    const { seen, fetchImpl } = fakeServer([readCaseReply, proposeReply]);
    const model = new OpenAICompatibleModel({ baseUrl: "http://fake.local/v1/", model: "oss-model", fetchImpl });
    const result = await planCase(model, fraudCase(), { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.gate?.accepted).toBe(true);
    expect(result.gate?.finalAction).toBe("CHALLENGE");

    const first = seen[0] as any;
    expect(first.messages[0].role).toBe("system");
    expect(first.messages[1]).toEqual({ role: "user", content: expect.stringContaining("dsp_demo_fraud") });
    expect(first.tools.map((t: any) => t.function.name).sort()).toEqual(["propose_action", "read_case"]);

    const second = seen[1] as any;
    const toolMsg = second.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(toolMsg.content).toContain("<case_documents>");
  });

  it("fails closed when the model answers in prose", async () => {
    const prose = { choices: [{ message: { role: "assistant", content: "Just challenge it.", tool_calls: null } }] };
    const { fetchImpl } = fakeServer([prose]);
    const model = new OpenAICompatibleModel({ baseUrl: "http://fake.local/v1/", model: "oss-model", fetchImpl });
    const result = await planCase(model, fraudCase(), { now: NOW, maxSteps: 1 });
    expect(result.ok).toBe(false);
    expect(result.policy.action).toBe("CHALLENGE");
  });
});
