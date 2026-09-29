# Accounting acceptance

Sonnet refusal billing follows [Anthropic's rules](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback),
verified September 28, 2026. Known unbilled pre-output refusals settle zero while
retaining token telemetry. Billed categories and partial-output refusals settle
their known usage; incomplete content is discarded. Unknown refusal categories
retain the conservative estimate. No refusal triggers a retry or fallback.

Paid delegation remains disabled during these checks. Use the development gateway and isolated test databases; never redirect tests to LibreChat's application database.

## Repeatable checks

From the repository root:

```sh
npm ci --prefix mission-ai/gateway --include=dev --ignore-scripts
npm run check --prefix mission-ai/gateway
npm run typecheck:native --prefix mission-ai/gateway
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

Before the first committed mutation on each connection, a transactional integrity audit compares historical events with stored balances. Missing state, orphan events, and numeric discrepancies block writes without repairing or discarding records. Reservations also verify current-month state/event agreement under the global transaction fence. Stop the gateway before any manual restore or repair and restart it afterward so the full historical audit runs before further paid work.

## Reservations and exact cost

Settled costs use provider-reported usage and the configured price catalog. Reservations are conservative holds, not invoices. `pricing.json` includes a configurable `reservation.inputOverheadTokens` allowance (initially 1024) in addition to UTF-8 input bytes and the highest configured input/cache rate. Image output is reserved at the highest output modality rate across the enforced token limit.

OpenAI requests explicitly select Standard processing and require confirmation of that tier in the response. Long-context rates apply to the entire request above 272,000 input tokens, including cached input and cache writes; the reservation selects the tier using its input upper estimate. These conditions were verified September 28 against the official [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), and [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) documentation. Regional processing and custom pricing require a separate catalog review before use.

The input allowance is not a provider-certified upper bound. An overrun stops further use and requires review. To resolve an accounting block, preserve the event, reconcile it with provider usage, correct the price or reservation model, verify the new bound, and obtain explicit approval for any ledger repair or unblock. No automatic unblock endpoint is provided.

## Remaining acceptance boundaries

The untouched production LibreChat service does not reserve native in-flight requests through this ledger. Its native spend is read from settled transactions. Consequently, a simultaneous native request can change total spending after the gateway's snapshot. The delegated ledger's atomic cap is tested with a known native-spend snapshot; it is not proof of a platform-wide atomic $175 ceiling. Do not enable general paid delegation or promote production until that cross-service boundary is addressed.

## Opt-in shared native mode

The TypeScript adapter in `packages/api/src/missionBudget` is compiled separately
by the gateway so it does not require the entire LibreChat runtime. The restricted
OpenAI-compatible route authenticates with a dedicated native token, allows only
priced OpenAI models, and reserves the full serialized text/tool payload plus
bounded output before one upstream call. It requires durable shared activation;
request bodies cannot supply credentials, dependencies, budget values, or URLs.
Unsupported APIs and modalities fail before dispatch. Client-facing SSE is
buffered until usage has been settled; token-by-token delivery is not provided.
The protocol follows the official [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

Shared activation atomically imports immutable native history and preserves
existing delegated costs. Native/delegated admission uses the stored hard cap
under one transaction fence. Subsequent dashboards use only ledger events;
LibreChat's transaction mirror is not added again. Local tests include real Mongo
races, activation replay/conflicts, billing-month transitions, fake-provider
failure cases, and OpenAI client JSON/SSE compatibility without paid calls.

These tests do not prove that a deployed LibreChat has no bypass route. The
[managed configuration and cutover checklist](../NATIVE_BUDGET_CUTOVER.md) must be
completed, including old-caller drain, historical reconciliation, deployment
restrictions, and explicitly approved live native acceptance. No activation
route is exposed over HTTP. The CLI requires a reviewed, unchanged plan digest
and both paid gates disabled. Its drain flag is an operator attestation.

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

## Pinned Anthropic text and free-search coverage

The Sonnet adapter covers translated multi-turn text, standard-only capacity, low effort, additive cache reads and separate 5m/1h writes, output caps, unknown usage, malformed display after settlement, deadline/cancellation retention, and SDK JSON/SSE delivery after accounting. Only the pinned Anthropic model is exposed by production native wiring. Tools are not silently converted without their thinking signatures. The managed model client must have zero retries. Offline fixtures make no provider calls. Live acceptance is still separately authorized.

Tavily basic search is separate from model analysis. `MISSION_AI_SEARCH_ENABLED=false` remains the preparation default. Runtime requires a key-bound PAYG-off verification less than 24 hours old, a Researcher account with a 1000-credit free allowance, a capped key, zero PAYG usage, and available account and key credits. Missing/positive PAYG limits fail closed; null is accepted only with the fresh external proof. Advanced/automatic search, answers, scraping and provider fallback are unavailable. The separate `MissionAI.free_search_state` collection provides atomic cross-instance free-credit holds and per-key high-water counts. Verified one-credit usage clears its pending hold before delivery; ambiguous usage or a crash leaves admission blocked across reconnects. New-period admission still requires fresh key-bound PAYG-off proof. These are free network credits, not model tokens or USD budget. Live exhausted-credit refusal and later positive free-credit acceptance remain required.
