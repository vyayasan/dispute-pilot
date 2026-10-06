// Live sandbox smoke test. Read-only: login + list disputes. Keys come from env, never printed.
import { AirwallexClient } from "../src/gateway/airwallex.js";
const id = process.env.AIRWALLEX_CLIENT_ID, key = process.env.AIRWALLEX_API_KEY;
if (!id || !key) { console.error("Set AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY first."); process.exit(2); }
const c = new AirwallexClient({ clientId: id, apiKey: key });
try {
  const r = await c.listDisputes();
  console.log(`PASS login + list disputes: ${r.items?.length ?? 0} dispute(s) visible`);
  for (const d of (r.items ?? []).slice(0, 5)) console.log(` - ${d.id} stage=${d.stage} status=${d.status} amount=${d.amount} ${d.currency} reason=${d.reason_code ?? d.reason ?? "?"}`);
} catch (e) { console.error("FAIL:", (e as Error).message); process.exit(1); }
