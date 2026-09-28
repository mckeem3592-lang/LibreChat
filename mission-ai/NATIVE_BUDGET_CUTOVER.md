# Managed native spending cutover

This is a prepared deployment and cutover procedure, not evidence of a deployed or activated service. Do not change `My-Workstation-McKee`, its database login, or its direct-provider configuration while preparing the new service. Production promotion, stopping its paid work, and redirecting users require explicit approval of the concrete deployment and cutover plan.

The managed configuration is [`config/librechat.shared-budget.yaml`](config/librechat.shared-budget.yaml). Load it as the complete configuration of a separate LibreChat service. Do not merge it with the broader legacy Mission AI configuration. The native gateway surface is `POST /native/openai/v1/chat/completions`, authenticated with a dedicated `MISSION_AI_NATIVE_TOKEN`. The managed LibreChat service receives this token; provider keys and the dedicated ledger writer remain on the gateway.

## Supported scope

The initial adapter supports allowlisted OpenAI text Chat Completions and function-tool message/schema transport. A function call describes work for its caller; accepting its schema does not authorize or account for an external tool's fees. This initial LibreChat configuration disables its native tools, agents, uploads, automatic titles/labels, memory generation, summarization, speech, and schedules. The managed text path must work first. Expanding a feature requires its own dispatch, maximum-cost, failure, and cancellation coverage.

The prepared model list is `gpt-6-luna`, `gpt-6-sol`, and `gpt-6-astra`, with a 4096-token output setting and Economy as the initial selection. Set gateway `MISSION_AI_NATIVE_MODELS=gpt-6-luna,gpt-6-sol,gpt-6-astra` only after those exact models pass the adapter's checks; it is a comma-separated allowlist of priced OpenAI model IDs. The gateway's allowlist, price catalog, request validation, output cap, and budget decisions are authoritative. Keep the YAML models/specs aligned and remove any unapproved model from both. Native transaction prices and UI estimates are not authoritative ledger settlements.

General Mission AI delegation remains `MISSION_AI_DELEGATION_ENABLED=false`. Native admission is separately disabled unless `MISSION_AI_NATIVE_ENABLED=true` and the shared ledger has been explicitly activated. Shared accounting mode is selected by that durable activation record; there is no separate shared-mode environment toggle. Do not use the tool token as the native token or add a public override of either gate.

## Configuration is not the whole boundary

The following behavior was checked in this repository:

| Control | What it does | What must also be enforced |
| --- | --- | --- |
| `ENDPOINTS=custom` | Omits built-in endpoints from normal configuration (`packages/data-provider/src/parsers.ts`, `getEnabledEndpoints`). | `orderEndpointsConfig` always retains configured custom endpoints. Load only `MissionAI`; block tenant/admin/database overrides adding others. Do not treat this variable as authorization for every route. |
| Fixed custom `apiKey` and `baseURL` | `packages/api/src/endpoints/custom/initialize.ts` uses managed environment values instead of the `user_provided` credential/URL mode. | No direct provider credentials, stored user tool credentials, alternate cloud identity, or user-provided destinations may be available to a managed request. Do not import them from production. |
| `modelSpecs.enforce=true` | `api/server/middleware/buildEndpointOption.js` validates the spec/endpoint and applies its preset over request fields on the ordinary chat path. | Other APIs do not all use this middleware. The gateway must independently reject unlisted models, unsupported fields, and unsupported API paths. |
| `dropParams: [useResponsesApi]` | `packages/api/src/endpoints/openai/llm.ts` explicitly selects Chat Completions before shaping fields. | Verify the actual managed client calls `/chat/completions`, including restored conversations and crafted requests. Responses, Assistants, batch/background, image, audio, file, and embedding APIs are unsupported. |
| `endpoints.agents.allowedProviders: [MissionAI]`, `capabilities: []` | Restricts saved-agent provider initialization where the agent provider guard applies; supplies no native capabilities. | An empty `allowedProviders` list would mean unrestricted. Agent/remote-agent/management routes, stored graphs, tools, background jobs, and per-role overrides still require negative testing and denial. |
| `interface` flags | Hide unsupported controls and feed parts of the role-permission configuration. | They are not universal route guards, especially for existing roles/admins, crafted requests, stored configurations, and direct speech/tool APIs. |
| `memory.disabled`, labels/titles off, summarization off | Disables these background model features in the prepared configuration. | Do not import saved-agent, title-endpoint, summary-provider, or plugin overrides that restore alternate dispatches. |
| `fileConfig.endpoints.*.disabled=true` | The normal upload validation rejects disabled endpoint uploads (`api/server/services/Files/process.js`, `filterFile`). | Existing files, alternate provisioning paths, and external RAG/OCR services are separate. No RAG/OCR credentials or route access are permitted in this initial deployment. |

The mandatory deployment boundary is fail-closed egress and route access. The managed LibreChat runtime may reach the approved gateway inference surface and separately enumerated infrastructure such as its database and authentication service. It must not reach direct inference, search, image, speech, embedding, scraping, reranking, code-execution, or arbitrary MCP/action hosts. Deny alternate HTTP proxies, cloud instance credentials, and configurable upstream destinations. Verify this boundary from the running workload, not just from UI visibility. If the hosting environment cannot enforce it, a reviewed server-side admission/route guard is required before claiming complete native coverage or enabling this deployment for paid work.

## Prepare the separate service without paid calls

1. Record the exact reviewed commit, successful CI, gateway adapter tests, price revision, deployment image, and configuration digest. Do not reuse a deployment whose source or settings have changed since review.
2. Give the managed LibreChat service a separate application database and its own least-privilege application login. Keep the original service's application database/login unchanged. Retain gateway `MISSION_AI_MONGO_URI` as the read-only historical source and `MISSION_AI_LEDGER_MONGO_URI` as the writer scoped to `MissionAI`; do not put either credential in this YAML or chat.
3. Set `CONFIG_PATH` to the absolute deployed path of `mission-ai/config/librechat.shared-budget.yaml` and `ENDPOINTS=custom`. Set `MISSION_AI_GATEWAY_URL` to the reviewed HTTPS gateway origin without a trailing slash. Provision a distinct, randomly generated native token of at least 32 characters privately on the gateway and managed LibreChat service. It must differ from the device and tool tokens. Keep it out of source, logs, screenshots, and browser-visible configuration. Explicitly set both gateway `MISSION_AI_NATIVE_ENABLED=false` and `MISSION_AI_DELEGATION_ENABLED=false` during preparation and import.
4. On the managed service, remove direct credentials and their `user_provided` sentinels. Inventory includes OpenAI/Assistants/Azure keys and base URLs, Anthropic/Vertex keys, Google/Gemini/service-account keys, Bedrock/AWS credentials and profiles, image/STT/TTS/search/scraper/reranker/code provider keys, and RAG/OCR configuration. Remove alternate `PROXY`/`HTTP_PROXY`/`HTTPS_PROXY` routing unless it is the reviewed enforcing egress proxy. Do not change these settings on the original service during preparation.
5. Start with clean managed configuration/role/plugin/credential state. History migration may copy approved conversations/messages; it must not blindly restore user keys, role overrides, custom endpoints, agents/graphs, assistants, MCP servers, actions, remote agents, active schedules, plugins, tenant config, or cloud credentials. Do not run the legacy `mission-ai-budget` prompt hook against the new database: its balance rewrite is not the shared ledger and has been superseded for this path.
6. Preserve `transactions.enabled=true` for local history, with `balance.enabled=false`. Native token-credit holds are not a second source of spendable budget. Confirm shared totals do not add post-cutover transaction copies to the gateway's settlement for those same requests.
7. Keep native and delegated paid gates off while checking readiness, authentication, schema compatibility, endpoint exposure, denied-route behavior, and egress. No provider POST is needed for these checks. Do not repeat the earlier paid acceptance runner; any new paid validation needs its own authorization.

## Drain, import, and activate only after promotion approval

Do not activate a shared cap while the original service or another holder of the same budget can still send unreserved paid requests. An idle browser is not proof of a drained server.

1. Present the exact managed deployment, original-service access change, restrictions, expected downtime, rollback, historical amount, and activation identity for approval. Until approved, leave production and its login unchanged and the native gate off.
2. After approval, stop new paid admission on the original service and every other in-scope caller. Suspend schedules, detached/background agents, tool workers, external RAG jobs, title/memory/summary generation, and remote API callers. Drain active requests and provider-side asynchronous work; reconcile cancelled/timed-out/ambiguous calls conservatively. Record the drain timestamp and the evidence that old credentials/callers can no longer create spend. Do not assume an HTTP disconnect cancels billing.
3. Export the final native accounting snapshot from the read-only `transactions` source with its exact database, month boundaries (`America/Denver`), cutoff, row count, amounts, and a digest of the export. Preserve the original records. Reconcile delayed transactions and earlier unrecorded categories against provider usage/invoices; record unresolved charges conservatively. The native table alone does not prove completeness: legacy image, audio, memory, search/RAG, and other tools have incomplete or absent accounting.
4. Prepare and review the cutover artifact, then apply that exact artifact with the CLI below. The importer covers current Denver-month charged native prompt/completion transaction rows only. It does not discover unrecorded image, speech, memory, search, RAG, or external-provider fees. Do not use it as a substitute for step 3's completeness reconciliation. Activation must be transactional and idempotent, refuse conflicting replays and pending reservations, retain provenance, and include existing delegated settlements without duplicating them. Import history as a distinct baseline/event source, not as replacement balances or fabricated native requests. Do not hand-edit `budget_state`.
5. Verify the activation receipt, persisted event/state agreement, settled baseline plus existing delegated charges, no unresolved reservation/quarantine, and remaining monthly capacity. Stop if the snapshot changed after export. The apply command re-reads native transactions, rejects new charges after the cutoff, and requires the approved digest to match. An environment toggle alone is not an import or activation receipt.
6. Verify that the durable activation selects shared accounting and that admission reads the same atomic `MissionAI` ledger for native and delegated requests. Freeze the historical snapshot at cutover; post-cutover native mirror transactions must not be counted again. Keep the old unreserved callers disabled. Set `MISSION_AI_NATIVE_ENABLED=true` only after these conditions and the deployment boundary checks pass. Leave `MISSION_AI_DELEGATION_ENABLED=false` unless it receives separate approval.
7. Perform only the newly authorized bounded native acceptance. Verify the managed endpoint, exact model/tier and emitted output limit, one provider dispatch, reported usage, one final settlement, reservation release, native/delegated shared capacity, and native history without double counting. Confirm the original service cannot make a paid request outside the gate. A passing standalone gateway test is not proof of this end-to-end native path.

From the reviewed gateway deployment directory, while both paid flags remain explicitly `false`:

```sh
node native-cutover.js plan --cutover-at APPROVED_UTC_ISO_CUTOFF --out PRIVATE_PLAN_PATH
```

The plan records a safe transaction summary and digest without conversation/message content. Review the exact cutoff, source, month, totals, and digest together with drain/reconciliation evidence. Protect the artifact as operational accounting data; it contains no credential values. After explicit approval of that exact plan, apply it once:

```sh
node native-cutover.js apply --plan PRIVATE_PLAN_PATH --approve-digest APPROVED_SHA256 --drained
```

The CLI requires the read-only `MISSION_AI_MONGO_URI` and dedicated `MISSION_AI_LEDGER_MONGO_URI`. The `--drained` flag is an operator attestation, not a mechanism that stops the original service or discovers in-flight provider requests. Do not pass it until draining is verified. Never generate a new plan/digest or adjust the cutoff automatically to bypass a stale-plan rejection. If the deployed CLI differs from this reviewed interface, stop and reconcile the code/procedure before applying it.

### Positive provider-usage reconciliation

An original transaction can understate a provider charge, for example when one-hour cache creation was priced as five-minute creation. Preserve that transaction. An optional version 2 cutover imports a separate positive `provider-reconciliation` event alongside the unchanged native history. It is not a native request, a provider dispatch, or a balance replacement. No general adjustment endpoint or post-activation amendment is provided.

First match the provider export to the original database, account/project, model, exact period, token categories and pricing modifiers. Retain a private scope attestation containing that review and the reproducible token/rate calculation. The supported basis is `provider_usage_and_published_rates`: it does not assert an exact invoice amount, and category totals rounded to cents are not exact billing evidence. File hashes prove which evidence was reviewed, not that its claims are correct. Unresolved scope or missing usage remains a blocker to activation.

Use a private JSON evidence bundle with exactly `version: 1`, `reconciliations`, and `evidenceFiles`. Each evidence-file entry has only `path` and lowercase `sha256`; relative paths resolve from the bundle's directory. Each nonempty file is limited to 5 MB. The file list must match exactly the unique hashes referenced by the corrections. Paths and raw file contents never enter the plan or safe CLI output.

Each reconciliation has only these fields:

- `provider`: `openai`, `anthropic`, or `google`.
- `reason`: `provider_usage_reconciliation`; `basis`: `provider_usage_and_published_rates`.
- `database`: the source database; `periodStart` and `periodEnd`: canonical UTC ISO timestamps, within the current Denver month and at or before cutoff. Coverage is start-inclusive/end-exclusive.
- `coveredHistoryIds`: a nonempty list of existing `DATABASE/transactions/ID` history IDs for that provider and period. A source row may be covered only once across corrections.
- `recordedNanoUsd`, `providerNanoUsd`, `adjustmentNanoUsd`: nonnegative safe integers, with a strictly positive adjustment. One USD is one billion nanodollars. The recorded amount must equal the covered native history; provider amount minus recorded amount must equal the adjustment. The token/rate calculation underlying the provider amount belongs in the retained evidence and requires operator review.
- `evidence`: exactly `usageSha256`, `pricingSha256`, and `scopeSha256`, each a lowercase SHA-256 of a retained private file. The pricing file should preserve the official source URL and observation date with the rates used; the scope file records account/period matching and pricing assumptions without credentials.

The importer derives a stable correction ID from provider, reason, database, period, covered IDs and scope evidence. The amount and all evidence hashes enter the approved plan and activation manifest. An optional saved `id` is accepted only if it matches this derivation. Unknown fields, unknown labels, repeated coverage, arithmetic mismatch, and nonpositive adjustments fail closed. This interface is for manually reviewed corrections; it does not parse provider CSVs or automatically discover unrecorded charges.

While both paid flags remain explicitly `false`, prepare v2 with:

```sh
node native-cutover.js plan --cutover-at APPROVED_UTC_ISO_CUTOFF --out PRIVATE_PLAN_PATH --reconciliations PRIVATE_EVIDENCE_BUNDLE
```

The safe receipt reports recorded native USD, reconciliation USD, corrected native USD, counts and digest separately. Review the private plan plus its evidence before approving the exact digest. After production drain and explicit activation approval, use:

```sh
node native-cutover.js apply --plan PRIVATE_PLAN_PATH --approve-digest APPROVED_SHA256 --drained --reconciliations PRIVATE_EVIDENCE_BUNDLE
```

Apply re-reads source transactions and evidence bytes; changed evidence, correction content or source data invalidates approval. The existing Mongo transaction/fence activates history, correction events, counters and control together. Identical retries are idempotent; conflicting manifests fail. Shared summaries expose `reconciliationUsd` as a fourth partition and include it once in settled spend, reservations, policy decisions and dashboard totals. Provider breakdowns include its dollars with task `provider-reconciliation`, without claiming extra requests. Ordinary reservation/settlement/release operations cannot alter the correction.

Without the optional bundle, version 1 plan bytes/digests and existing activation-manifest hashes remain unchanged. Legacy shared ledgers have zero reconciliation dollars. A version 2 activation is not compatible with rolling back to code that does not recognize its source; preserve paid gates off during rollout/rollback review. Never switch an activated ledger back to native snapshot accounting or hand-edit its state to remove the adjustment.

## Unsupported paths must stay denied

| Feature | Examples of separate dispatch paths | Initial disposition |
| --- | --- | --- |
| Direct models or provider-native APIs | User/custom credentials, OpenAI Responses, Azure, Bedrock, Vertex, Anthropic/Gemini, legacy Assistants runs/tool-output submission | No direct credentials/egress; only the managed adapter protocol/model allowlist is enabled. |
| Images and multimodal input/output | `OpenAIImageTools`, `DALLE3`, `GeminiImageGen`, `FluxAPI`, `StableDiffusion`; image/audio/file/video message parts | No native image tools or uploads; reject unsupported gateway payloads. |
| Audio | `Files/Audio/STTService` and `TTSService`, including repeated speech chunks | No speech provider configuration/credentials; deny direct route/egress access. Hiding the tab is insufficient. |
| Retrieval, OCR, and research | `VectorDB/crud.js` `/embed`; `files/rag/search.ts` `/query`; OCR, Tavily/Google search, external search/scraper/reranker SDKs | No service URLs/keys/tool access; deny egress. These fees are not token usage from the native chat adapter. |
| Background model calls | Automatic titles, activity/reasoning labels, memory extraction, compaction, detached agents, schedules | Disabled in prepared config; reject stored/plugin/role overrides and drain old work. |
| Arbitrary paid tools | MCP servers, actions, skills with execution, code services, remote agents | No configured/registered tool destinations, no stored credentials, denied permissions and egress. Function-tool protocol support does not imply permission for these tools. |

## Acceptance evidence and rollback

Before declaring shared native control complete, retain all of the following:

- Exact commit/configuration and deployed endpoint identity; independent review and passing relevant tests.
- Private-token authentication rejects missing, wrong, tool-token, and browser/user-supplied credentials without provider dispatch. No secret appears in the public config or logs.
- Only the managed endpoint/models are offered; crafted direct-provider, unknown-model, Responses, Assistants, tools, audio/image/file/RAG, key/URL override, and scheduled/remote execution attempts cannot cause external billing.
- A failed reservation or unavailable shared ledger blocks provider dispatch. Parallel native and delegated attempts share one cap. SDK retries, cancellation, incomplete/malformed usage, timeout, settlement failure, restart, and month rollover retain money conservatively and cannot double settle.
- Egress denial and clean stored configuration are verified from the actual workload. Every paid provider account/caller in the claimed budget is either governed or explicitly excluded; exclusions prevent a platform-wide ceiling claim.
- Historical export/activation receipts and final ledger reconciliation prove no missing or duplicated cutover spend. Native post-cutover transaction copies are not summed twice.
- The approved native acceptance reconciles actual provider usage with its durable event and shared balance. Estimated, pending, or quarantined outcomes do not pass exact accounting acceptance.

If any check fails, set the native gate off and stop new managed paid admission. Preserve activation records, claims, reservations, events, exports, and provider evidence. Reconcile uncertain dispatches; never delete a hold or claim to force a retry. Do not revert the gateway to snapshot accounting or restore direct credentials while presenting the shared cap as active. Resuming the original unguarded service is a separate, explicitly approved rollback that suspends the shared-cap claim. Restoring or repairing ledger data requires stopping writers and restarting the gateway so its integrity audit runs again.
