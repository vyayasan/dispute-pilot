import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createConsoleApi } from "./api.js";
import { page } from "./page.js";
import { AuditLog } from "../audit/audit.js";

const PORT = Number(process.env.PORT ?? 3000);
const sessionToken = randomBytes(24).toString("hex"); // per run; only the page we serve gets it
const allowedHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
const allowedOrigins = allowedHosts.map((h) => `http://${h}`);
const api = createConsoleApi({ key: randomBytes(32).toString("hex"), approver: "demo-reviewer", sessionToken, allowedOrigins, audit: new AuditLog("audit.jsonl") });
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
