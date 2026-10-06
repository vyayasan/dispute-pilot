// A small, typed seam to the language model. The planner only ever sees this interface, so tests mock it and
// no other module can reach the network. The API key is read from the environment at the edge and kept in a
// closure; it is never logged, put in an error message or written to the audit log.
export interface ToolSpec { name: string; description: string; input_schema: Record<string, unknown> }
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export interface Message { role: "user" | "assistant"; content: string | Block[] }
export interface ModelRequest { system: string; messages: Message[]; tools: ToolSpec[] }
export interface ModelClient { step(req: ModelRequest): Promise<Block[]> }

export interface AnthropicOptions { apiKey: string; model?: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }

// Override with ANTHROPIC_MODEL. Default: the current Sonnet at the time of writing (platform.claude.com model overview, October 2026).
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export class AnthropicModel implements ModelClient {
  private readonly send: (body: string) => Promise<Response>;
  constructor(o: AnthropicOptions) {
    if (!o.apiKey) throw new Error("an API key is required");
    const f = o.fetchImpl ?? fetch; const base = o.baseUrl ?? "https://api.anthropic.com"; const key = o.apiKey;
    this.model = o.model ?? DEFAULT_MODEL; this.timeoutMs = o.timeoutMs ?? 30_000;
    this.send = (body) => f(`${base}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(this.timeoutMs),
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body,
    });
  }
  private model: string; private timeoutMs: number;

  async step(req: ModelRequest): Promise<Block[]> {
    // Claude Sonnet 5.5 rejects forced tool use (tool_choice "any" or "tool"), so the request uses "auto" and the system prompt
    // says when to call a tool. If the reply has no tool call the planner nudges once and then fails closed to policy.
    // max_tokens leaves room for adaptive thinking, which counts toward it. Thinking blocks are passed back unchanged
    // (the conversation is append-only), and no sampling parameters are sent because the model returns 400 for them.
    const r = await this.send(JSON.stringify({ model: this.model, max_tokens: 4096, system: req.system, messages: req.messages, tools: req.tools, tool_choice: { type: "auto" } }));
    const j: any = await r.json().catch(() => ({}));
    // Only the status and error type are surfaced, never the request or its headers.
    if (!r.ok) throw new Error(`model request failed: ${r.status} ${String(j?.error?.type ?? "error").slice(0, 60)}`);
    if (!Array.isArray(j.content)) throw new Error("model response had no content");
    return j.content as Block[];
  }
}

/** Build the client from the environment, or return undefined when nothing is configured (the planner is then off).
 * ANTHROPIC_API_KEY wins. Without it, any OpenAI-compatible endpoint works: EXTRACTION_BASE_URL + EXTRACTION_MODEL
 * (plus EXTRACTION_API_KEY when the provider wants one). EXTRACTION_MAX_TOKENS and EXTRACTION_REASONING_EFFORT fit
 * tight free-tier limits. The provider is config, not code. */
export function modelFromEnv(env: Record<string, string | undefined> = process.env): ModelClient | undefined {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey) return new AnthropicModel({ apiKey, model: env.ANTHROPIC_MODEL || undefined });
  const baseUrl = env.EXTRACTION_BASE_URL; const model = env.EXTRACTION_MODEL;
  return baseUrl && model ? new OpenAICompatibleModel({ baseUrl, model, apiKey: env.EXTRACTION_API_KEY }) : undefined;
}
// OpenAI-compatible backend (Groq, OpenRouter, Ollama, vLLM, ...). Same seam:
// the planner speaks Anthropic-shaped blocks, this class translates both ways.
// Keys stay in a closure and are never logged, same discipline as above.
export interface OpenAICompatibleOptions { baseUrl: string; model: string; apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number }

export class OpenAICompatibleModel implements ModelClient {
  private readonly send: (body: string) => Promise<Response>;
  private readonly model: string; private readonly timeoutMs: number;
  constructor(o: OpenAICompatibleOptions) {
    if (!o.baseUrl) throw new Error("a base URL is required");
    if (!o.model) throw new Error("a model name is required");
    const f = o.fetchImpl ?? fetch; const base = o.baseUrl.replace(/\/+$/, ""); const key = o.apiKey;
    this.model = o.model; this.timeoutMs = o.timeoutMs ?? 60_000;
    this.send = (body) => f(`${base}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(this.timeoutMs),
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" }, body,
    });
  }

  async step(req: ModelRequest): Promise<Block[]> {
    const messages: unknown[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (typeof m.content === "string") { messages.push({ role: m.role, content: m.content }); continue; }
      if (m.role === "assistant") {
        const text = (m.content as Block[]).filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
        const calls = (m.content as Block[]).filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
          .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
        messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        for (const b of m.content as Block[]) {
          if (b.type === "tool_result") messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
          else if (b.type === "text") messages.push({ role: "user", content: b.text });
        }
      }
    }
    const body = JSON.stringify({
      model: this.model, messages, temperature: 0, max_tokens: Number(process.env.EXTRACTION_MAX_TOKENS ?? 4096),
        // Some free tiers cap output tokens/min hard; reasoning effort is env-tunable to fit (e.g. "none").
        ...(process.env.EXTRACTION_REASONING_EFFORT ? { reasoning_effort: process.env.EXTRACTION_REASONING_EFFORT } : {}),
      tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: "auto",
    });
    const r = await this.send(body);
    const j: any = await r.json().catch(() => ({}));
    // Only the status and provider error type are surfaced, never the request or its headers.
    if (!r.ok) {
      // Status plus provider error type/code, and a truncated provider message when it carries the failing limit
      // (rate-limit details only). Never the request or its headers.
      const msg = /rate.limit|token|quota/i.test(String(j?.error?.message ?? "")) ? ` - ${String(j.error.message).slice(0, 140)}` : "";
      throw new Error(`model request failed: ${r.status} ${String(j?.error?.type ?? j?.error?.code ?? "error").slice(0, 60)}${msg}`);
    }
    const msg = j?.choices?.[0]?.message;
    if (!msg) throw new Error("model response had no choices");
    const blocks: Block[] = [];
    if (typeof msg.content === "string" && msg.content.trim()) blocks.push({ type: "text", text: msg.content });
    for (const call of msg.tool_calls ?? []) {
      let input: unknown;
      try { input = JSON.parse(call?.function?.arguments ?? "{}"); }
      catch { blocks.push({ type: "text", text: "[tool call dropped: arguments were not valid JSON]" }); continue; }
      blocks.push({ type: "tool_use", id: String(call.id), name: String(call?.function?.name ?? ""), input });
    }
    if (!blocks.length) blocks.push({ type: "text", text: "" });
    return blocks;
  }
}

