import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createConsoleApi } from "./api.js";
import { page } from "./page.js";
import { AuditLog } from "../audit/audit.js";
import { AirwallexClient } from "../gateway/airwallex.js";
import { LiveGateway } from "../gateway/live.js";
import { modelFromEnv } from "../agent/model.js";
import { planCase } from "../agent/planner.js";

const PORT = Number(process.env.PORT ?? 3000);
const sessionToken = randomBytes(24).toString("hex"); // per run; only the page we serve gets it
const allowedHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
const allowedOrigins = allowedHosts.map((h) => `http://${h}`);
// Set AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY to run against the Airwallex sandbox; otherwise the in-memory simulator is used.
// Merchant-side order facts Airwallex does not hold. A demo can supply them per dispute id in runs/demo-facts.json.
const demoFacts: Record<string, unknown> = existsSync("runs/demo-facts.json") ? JSON.parse(readFileSync("runs/demo-facts.json", "utf8")) : {};
const live = process.env.AIRWALLEX_CLIENT_ID && process.env.AIRWALLEX_API_KEY
  ? new LiveGateway({ client: new AirwallexClient({ clientId: process.env.AIRWALLEX_CLIENT_ID, apiKey: process.env.AIRWALLEX_API_KEY }), actor: "demo-reviewer",
      factsFor: (d) => ({ deviceIpMatchesPriorUndisputed: 0, signedDelivery: null, unansweredSupportEmails: 0, ...(demoFacts[d.id] ?? {}) }) })
  : undefined;
// ANTHROPIC_API_KEY turns on the model planner. Without it /api/plan answers 501 and policy alone decides, as before.
const model = modelFromEnv();
const api = createConsoleApi({ gateway: live, planner: model ? (c) => planCase(model, c) : undefined, key: randomBytes(32).toString("hex"), approver: "demo-reviewer", sessionToken, allowedOrigins, audit: new AuditLog("audit.jsonl") });
const server = createServer(async (req, res) => {
  try {
    // Host allowlist blocks DNS-rebinding: a rebound hostname will not match.
    if (!allowedHosts.includes(String(req.headers.host))) { res.writeHead(403); res.end("bad host"); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page.replace("</head>", `<meta name="console-token" content="${sessionToken}"></head>`)); return;
    }
    if (url.pathname.startsWith("/api/")) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(url, { method: req.method, headers: req.headers as HeadersInit, body });
      const response = await api(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "internal error" }));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`dispute-pilot console: http://localhost:${PORT}`));
