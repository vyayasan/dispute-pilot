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

/** Build the client from the environment, or return undefined when no key is set (the planner is then off). */
export function modelFromEnv(env: Record<string, string | undefined> = process.env): ModelClient | undefined {
  const apiKey = env.ANTHROPIC_API_KEY;
  return apiKey ? new AnthropicModel({ apiKey, model: env.ANTHROPIC_MODEL || undefined }) : undefined;
}
