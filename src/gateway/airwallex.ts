import { randomUUID } from "node:crypto";

// Thin typed client for the Airwallex sandbox. Credentials come from the caller (env at the edge), never from code.
// Behaviour taken from the public docs: login with x-client-id / x-api-key returns a ~30 minute bearer token;
// every mutating call carries a unique request_id; accept/challenge live under /api/v1/pa/payment_disputes/{id}.
export interface ClientOpts {
  clientId: string; apiKey: string;
  baseUrl?: string; filesUrl?: string;
  fetchImpl?: typeof fetch; now?: () => number; maxRps?: number;
  sleep?: (ms: number) => Promise<void>;
}
export class AirwallexError extends Error {
  constructor(public status: number, public code: string, message: string) { super(`${status} ${code}: ${message}`); }
}

export class AirwallexClient {
  private token = ""; private tokenExp = 0; private stamps: number[] = [];
  private f: typeof fetch; private now: () => number; private sleep: (ms: number) => Promise<void>;
  private base: string; private files: string; private maxRps: number;
  constructor(private o: ClientOpts) {
    if (!o.clientId || !o.apiKey) throw new Error("clientId and apiKey are required");
    this.f = o.fetchImpl ?? fetch; this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.base = o.baseUrl ?? "https://api.sandbox.airwallex.com"; this.files = o.filesUrl ?? "https://files.sandbox.airwallex.com";
    this.maxRps = o.maxRps ?? 8; // docs: 20 rps global, 10 per endpoint
  }
  private async throttle() {
    for (;;) {
      const t = this.now(); this.stamps = this.stamps.filter((s) => t - s < 1000);
      if (this.stamps.length < this.maxRps) { this.stamps.push(t); return; }
      await this.sleep(1000 - (t - this.stamps[0]) + 1);
    }
  }
  private async auth(): Promise<string> {
    if (this.token && this.now() < this.tokenExp - 60_000) return this.token;
    await this.throttle();
    const r = await this.f(`${this.base}/api/v1/authentication/login`, { method: "POST", headers: { "x-client-id": this.o.clientId, "x-api-key": this.o.apiKey } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new AirwallexError(r.status, j.code ?? "auth_failed", j.message ?? "login failed");
    this.token = j.token; this.tokenExp = this.now() + 25 * 60_000; // refresh well inside the 30 min life
    return this.token;
  }
  // requestId should be stable per logical action (e.g. the approval nonce) so a retry after a timeout is deduplicated by Airwallex.
  private async call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, requestId?: string): Promise<T> {
    const token = await this.auth(); await this.throttle();
    const payload = method === "POST" ? { request_id: requestId ?? randomUUID(), ...(body ?? {}) } : undefined;
    const r = await this.f(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new AirwallexError(r.status, j.code ?? "error", j.message ?? "request failed");
    return j as T;
  }
  // Evidence goes through the File Service first; the returned id is what a challenge refers to. JPG or PDF only.
  async uploadFile(name: string, bytes: Uint8Array, contentType: "image/jpeg" | "application/pdf"): Promise<{ file_id: string }> {
    const token = await this.auth(); await this.throttle();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), name);
    const r = await this.f(`${this.files}/api/v1/files/upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.file_id) throw new AirwallexError(r.status, j.code ?? "upload_failed", j.message ?? "file upload failed");
    return { file_id: j.file_id };
  }
  // The list endpoint pages at 10 by default and takes up to 1000 per page, so ask for a full page of cases that still need an answer.
  listDisputes(opts: { status?: string; size?: number } = {}) {
    const q = new URLSearchParams({ size: String(opts.size ?? 100) }); if (opts.status) q.set("status", opts.status);
    return this.call<{ items: any[] }>("GET", `/api/v1/pa/payment_disputes?${q}`);
  }
  getDispute(id: string) { return this.call<any>("GET", `/api/v1/pa/payment_disputes/${encodeURIComponent(id)}`); }
  accept(id: string, reason: "LOW_VALUE_TRANSACTION" | "VALID_CUSTOMER_DISPUTE" | "OTHERS", acceptedBy: string, requestId?: string) {
    return this.call<any>("POST", `/api/v1/pa/payment_disputes/${encodeURIComponent(id)}/accept`, { accepted_by: acceptedBy, reason, description: "Accepted by dispute-pilot after approval" }, requestId);
  }
  challenge(id: string, challengedBy: string, extra: Record<string, unknown> = {}, requestId?: string) {
    return this.call<any>("POST", `/api/v1/pa/payment_disputes/${encodeURIComponent(id)}/challenge`, { challenge_method: "STANDARD", challenged_by: challengedBy, ...extra }, requestId);
  }
  // Sandbox-only simulators, kept behind this one client as the guide advises.
  // due_at is required by the simulator: it becomes the new response deadline at the next stage (ISO date-time).
  simulateEscalate(id: string, dueAt: string, requestId?: string) { return this.call<any>("POST", `/api/v1/simulation/pa/payment_disputes/${encodeURIComponent(id)}/escalate`, { due_at: dueAt }, requestId); }
}
