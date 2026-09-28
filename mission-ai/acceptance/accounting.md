# Accounting acceptance

Paid delegation remains disabled during these checks. Use the development gateway and isolated test databases; never redirect tests to LibreChat's application database.

## Repeatable checks

From the repository root:

```sh
npm ci --prefix mission-ai/gateway --include=dev --ignore-scripts
npm run check --prefix mission-ai/gateway
npm test --prefix mission-ai/gateway
npm run test:integration --prefix mission-ai/gateway
```

The integration suite starts its own MongoDB 8.0.17 replica set on loopback, with no Atlas URI or provider credentials. Its temporary database contains only synthetic accounting records. MongoDB's test failpoints verify that interrupted writes cannot leave an event and its monthly balance out of agreement. The regular deployment tests do not download or start this test database.

## Accounting guarantees

- Reservation, settlement, release, and stale-reservation settlement update the event and monthly balance in one MongoDB transaction. The runtime therefore requires a replica set or transaction-capable Atlas deployment.
- Reservation IDs are unique. Repeated identical reservations or settlements do not double-count money; conflicting or finalized reservation reuse fails.
- Provider calls use the same validated output-token limit as their reservation. Image requests enforce a total output limit rather than trusting a requested image count.
- Gemini reasoning tokens are counted. Missing or malformed usage is never interpreted as free usage.
- Ambiguous responses, timeouts, and server errors retain a conservative charge. Internal failures after dispatch preserve the reservation for reconciliation instead of restoring spendable budget.
- Fallback attempts refresh the budget and switch to economy routing when accumulated charges require it.
- A charge exceeding its reservation is recorded in full. The ledger sets `accountingBlocked` and rejects further reservations, including in later months. It does not discard the charge to make the balance fit the estimate.

The first ledger write establishes a unique `reservationId` index. Duplicate legacy records make initialization fail closed; do not delete or rewrite records automatically to make the index succeed.

Before the first committed mutation on each connection, a transactional integrity audit compares historical events with stored balances. Missing state, orphan events, and numeric discrepancies block writes without repairing or discarding records. This full audit is cached for the connection; it is not a continuous detector for external edits. Stop the gateway before any manual restore or repair and restart it afterward so the audit runs before further paid work. Later reservations also refuse to recreate a missing balance over existing events.

## Reservations and exact cost

Settled costs use provider-reported usage and the configured price catalog. Reservations are conservative holds, not invoices. `pricing.json` includes a configurable `reservation.inputOverheadTokens` allowance (initially 1024) in addition to UTF-8 input bytes and the highest configured input/cache rate. Image output is reserved at the highest output modality rate across the enforced token limit.

OpenAI requests explicitly select Standard processing and require confirmation of that tier in the response. Long-context rates apply to the entire request above 272,000 input tokens, including cached input and cache writes; the reservation selects the tier using its input upper estimate. These conditions were verified September 28 against the official [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), and [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) documentation. Regional processing and custom pricing require a separate catalog review before use.

The input allowance is not a provider-certified upper bound. An overrun stops further use and requires review. To resolve an accounting block, preserve the event, reconcile it with provider usage, correct the price or reservation model, verify the new bound, and obtain explicit approval for any ledger repair or unblock. No automatic unblock endpoint is provided.

## Remaining acceptance boundaries

The untouched production LibreChat service does not reserve native in-flight requests through this ledger. Its native spend is read from settled transactions. Consequently, a simultaneous native request can change total spending after the gateway's snapshot. The delegated ledger's atomic cap is tested with a known native-spend snapshot; it is not proof of a platform-wide atomic $175 ceiling. Do not enable general paid delegation or promote production until that cross-service boundary is addressed.

No unit or integration test calls a paid provider. A live acceptance test requires a separately authorized, durable one-shot run with a fixed maximum charge, no fallback, real usage reconciliation, and delegation still disabled globally. An estimated or pending charge is not a passing exact-cost result.

## Dormant live acceptance runner

`paid-acceptance.js` is not called by the server. After explicit approval, an operator may run it once in the existing development gateway environment, reusing the server-side OpenAI key without copying it:

```sh
node paid-acceptance.js \
  --approved-run-id APPROVED_UUID \
  --approved-model APPROVED_ECONOMY_MODEL \
  --approved-pricing-date APPROVED_CATALOG_DATE \
  --approved-source-sha APPROVED_DEPLOYED_COMMIT
```

The approval values must match the economy catalog and `RENDER_GIT_COMMIT`. The runner requires delegation to remain false, dedicated database connections, a clear ledger, and room for a $0.05 reservation. It allows one fixed text request to the official OpenAI endpoint with a 128-token output limit, no tools, redirect, retry, or fallback. A majority-written claim in `MissionAI.paid_acceptance_claims` permanently consumes the run ID before dispatch. Reusing that ID after any restart cannot make another request.

`PASS` requires reported usage, a settled event, and an independently read matching balance change. Uncertain charges are retained conservatively and never pass. A crash after dispatch retains its reservation for reconciliation. If a temporary Render start command is used, restore the normal `cd mission-ai/gateway && npm start` command after the check and verify the normal deployment. Do not retry a failed live check with a new run ID without new approval.
