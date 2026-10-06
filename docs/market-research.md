# What we checked, and what we took

One bounded pass over other payments and spend platforms for anything that sharpens the dispute agent. Only clear wins were adopted. Sources are public docs read on 2026-10-06.

| Platform | What we read | Taken | Not taken |
|---|---|---|---|
| Stripe | Dispute object and API ([object](https://docs.stripe.com/api/disputes/object), [API guide](https://docs.stripe.com/disputes/api)) | Evidence details model: `due_by`, `past_due`, `has_evidence`, `submission_count`. We use it as the basis for the deadline guard (a bad or past deadline fails closed to escalate) and the one-shot rule after an issuer rejection. Status `prevented` confirms pre-dispute programs (RDR style) belong in the lifecycle vocabulary. Visa CE 3.0 is a first-class eligibility type, same as our footprint check. | Webhook event names. Airwallex has its own. |
| Marqeta | [Disputes guide](https://www.marqeta.com/docs/developer-guides/about-disputes.md) | Two-layer lifecycle: your own case states while preparing, network states after submission (initiated, representment, pre-arbitration, arbitration, won or lost). Our stage plus status pair follows the same idea, and the docs map each step to it. | Issuer-side flow (we are the merchant side). |
| Ramp | [Agent approval skill](https://agents.ramp.com/skills/ramp-approval-dashboard) | Every agent action carries a required rationale; never blind-approve; a rejection requires a reason. Now in the code: the signed approval carries the agent's rationale, and rejecting a recommendation needs a typed reason that lands in the audit log. Highest amounts shown first is a queue rule to adopt next. | CLI shape. |
| Brex | [Cards API](https://developer.brex.com/openapi/team_api/cards/updatecard.md) | Spend controls as data (limit, expiry date, allowed merchants). Matches our policy config: autonomy cap and approval expiry are data, not prose. | Card issuing. |
| Thredd, Paymentology | [Thredd chargebacks](https://cardsapidocs.thredd.com/docs/chargebacks), [Paymentology disputes](https://developer.sprint.paymentology.com/card-api/disputes/) | Confirms the issuer-side vocabulary (dispute, chargeback, representment, reason codes). No change to our model. | Issuer-side APIs: out of scope for a merchant dispute agent. |

## What this means for the pitch

- The dispute lifecycle in the repo is the shared industry shape, not an invention: preparation states, then network states, with a single response window per stage.
- Approval binding plus a required rationale is the pattern the newer agent products (Ramp) already ask of agents. We bind it cryptographically.
- Honest limit: this was a read of public docs. No integration with any of these platforms exists in the code.
