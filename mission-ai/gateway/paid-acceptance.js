import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryCostDashboard } from './dashboard.js';
import { loadModelCatalog } from './model-catalog.js';
import { requestBudget } from './request-budget.js';
import { createMongoUsageLedger } from './usage-ledger.js';
import { calculateUsageCost, loadPricing, maximumTextRequestCost } from './cost.js';
import { executeProvider, ProviderRequestError } from './provider-client.js';
import { monthStartFor } from '../../plugin/mission-ai-budget/scripts/budget-time.mjs';

const RESERVE_USD = 0.05;
const OUTPUT_TOKENS = 128;
const PROMPT = 'Reply only with OK.';
const PROVIDER_URLS = { openai: 'https://api.openai.com/v1/responses', anthropic: 'https://api.anthropic.com/v1/messages' };
const WRITE_CONCERN = { w: 'majority', wtimeoutMS: 5000 };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const SHA = /^[\da-f]{40}$/i;

function failure(code) {
  const error = new Error(code);
  error.acceptanceCode = code;
  return error;
}

function safeReason(error, fallback) {
  const allowed = new Set([
    'acceptance_configuration_invalid', 'acceptance_approval_mismatch',
    'acceptance_already_claimed', 'acceptance_claim_uncertain',
    'acceptance_dispatch_claim_uncertain', 'acceptance_provider_request_invalid',
    'acceptance_postcheck_failed', 'acceptance_pending_reservations',
    'acceptance_month_boundary', 'acceptance_model_mismatch', 'acceptance_output_missing',
    'acceptance_estimate_exceeds_cap', 'acceptance_model_not_configured',
    'provider_not_configured', 'provider_http_error', 'provider_timeout',
    'provider_network_error', 'provider_invalid_response', 'provider_usage_invalid',
    'provider_service_tier_unverified',
    'monthly_hard_limit', 'ledger_accounting_blocked', 'invalid_budget_snapshot',
    'ledger_integrity_invalid', 'ledger_state_invalid',
    'reservation_underestimated',
  ]);
  const code = error?.acceptanceCode || error?.code || error?.message;
  return allowed.has(code) ? code : fallback;
}

export function createMongoAcceptanceStore({ uri, dbName }) {
  if (!uri || dbName !== 'MissionAI') throw failure('acceptance_configuration_invalid');
  let connection;
  let pending;
  async function db() {
    if (!pending) {
      connection = mongoose.createConnection(uri, {
        dbName, maxPoolSize: 2, serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000, socketTimeoutMS: 5000,
      });
      pending = connection.asPromise();
    }
    return pending;
  }
  return {
    async claim(record) {
      try {
        const result = await (await db()).collection('paid_acceptance_claims')
          .insertOne(record, { writeConcern: WRITE_CONCERN });
        if (!result.acknowledged) throw failure('acceptance_claim_uncertain');
      } catch (error) {
        throw failure(error?.code === 11000 ? 'acceptance_already_claimed' : 'acceptance_claim_uncertain');
      }
    },
    async readClaim(runId) {
      return (await db()).collection('paid_acceptance_claims').findOne(
        { _id: runId }, { projection: { _id: 1, stage: 1, result: 1 }, maxTimeMS: 5000 },
      );
    },
    async markDispatch(runId, reservationId) {
      try {
        const result = await (await db()).collection('paid_acceptance_claims').updateOne(
          { _id: runId, stage: 'claimed' },
          { $set: { stage: 'dispatch_started', reservationId, updatedAt: new Date() } },
          { writeConcern: WRITE_CONCERN },
        );
        if (!result.acknowledged || result.modifiedCount !== 1) {
          throw failure('acceptance_dispatch_claim_uncertain');
        }
      } catch {
        throw failure('acceptance_dispatch_claim_uncertain');
      }
    },
    async complete(runId, result) {
      const response = await (await db()).collection('paid_acceptance_claims').updateOne(
        { _id: runId },
        { $set: { stage: 'finished', result, updatedAt: new Date() } },
        { writeConcern: WRITE_CONCERN },
      );
      if (!response.acknowledged || response.matchedCount !== 1) {
        throw failure('acceptance_postcheck_failed');
      }
    },
    async readEvent(reservationId) {
      const rows = await (await db()).collection('delegated_usage').find(
        { reservationId },
        { projection: { _id: 0, reservationId: 1, status: 1, reservedUsd: 1,
          actualUsd: 1, usage: 1, metadata: 1, underestimated: 1 }, maxTimeMS: 5000 },
      ).limit(2).toArray();
      if (rows.length !== 1) throw failure('acceptance_postcheck_failed');
      return rows[0];
    },
    async close() {
      await pending?.catch(() => {});
      await connection?.close();
    },
  };
}

export async function runPaidAcceptance({
  approvedRunId,
  approvedProvider = 'openai',
  approvedModel,
  approvedPricingDate,
  approvedSourceSha,
  env = process.env,
  now = new Date(),
  dashboardReader = queryCostDashboard,
  pricingLoader = loadPricing,
  catalogLoader = loadModelCatalog,
  usageLedger,
  claimStore,
  fetchImpl = fetch,
} = {}) {
  const started = Date.now();
  let requestCount = 0;
  let reservation;
  let reservationAttempted = false;
  let before;
  let ledger = usageLedger;
  let store = claimStore;
  let claimed = false;
  const owned = !usageLedger && !claimStore;
  const role = 'economy';
  const provider = approvedProvider;
  const anthropic = provider === 'anthropic';
  const serviceTier = anthropic ? 'standard_only' : 'default';
  let standardTierVerified = !anthropic;
  const safe = { runId: UUID.test(approvedRunId || '') ? approvedRunId : null,
    provider, role, reservedUsd: RESERVE_USD, maxOutputTokens: OUTPUT_TOKENS,
    requestedServiceTier: serviceTier };
  const report = (status, fields = {}) => ({ ...safe, status, ...fields,
    requestCount, elapsedMs: Date.now() - started });
  const finish = async (status, fields = {}) => {
    const result = report(status, fields);
    if (claimed) await store.complete(approvedRunId, result);
    return result;
  };

  try {
    if (!['openai', 'anthropic'].includes(provider) || !UUID.test(approvedRunId || '') ||
        String(env.MISSION_AI_DELEGATION_ENABLED).toLowerCase() !== 'false' ||
        !env.MISSION_AI_LEDGER_MONGO_URI || env.MISSION_AI_LEDGER_DB !== 'MissionAI' ||
        !env.MISSION_AI_MONGO_URI ||
        (!anthropic && (!env.OPENAI_API_KEY || (env.OPENAI_API_BASE_URL && env.OPENAI_API_BASE_URL !== 'https://api.openai.com/v1'))) ||
        (anthropic && (!env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY !== env.ANTHROPIC_API_KEY || env.MISSION_AI_NATIVE_ENABLED !== 'false' ||
          (env.ANTHROPIC_API_BASE_URL && env.ANTHROPIC_API_BASE_URL !== 'https://api.anthropic.com'))) ||
        Boolean(usageLedger) !== Boolean(claimStore)) {
      throw failure('acceptance_configuration_invalid');
    }
    if (!SHA.test(approvedSourceSha || '') || env.RENDER_GIT_COMMIT !== approvedSourceSha) {
      throw failure('acceptance_approval_mismatch');
    }
    const [catalog, pricing] = await Promise.all([catalogLoader(), pricingLoader()]);
    const model = env[`MISSION_AI_MODEL_${role.toUpperCase()}`] || catalog?.providers?.[provider]?.[role];
    if (!model || !Object.values(catalog?.providers?.[provider] || {}).includes(model)) {
      throw failure('acceptance_model_not_configured');
    }
    const pricingDate = pricing?.models?.[model]?.verifiedOn ?? pricing?.verifiedOn;
    if (model !== approvedModel || (anthropic && model !== 'claude-sonnet-5-5') || !/^\d{4}-\d{2}-\d{2}$/.test(approvedPricingDate || '') ||
        pricingDate !== approvedPricingDate) throw failure('acceptance_approval_mismatch');
    Object.assign(safe, { model, pricingVerifiedOn: approvedPricingDate, sourceSha: approvedSourceSha });
    const estimatedMaximumUsd = maximumTextRequestCost({
      provider, model, prompt: PROMPT, system: '', maxOutputTokens: OUTPUT_TOKENS, pricing,
    });
    if (!Number.isFinite(estimatedMaximumUsd) || estimatedMaximumUsd <= 0 || estimatedMaximumUsd > RESERVE_USD) {
      throw failure('acceptance_estimate_exceeds_cap');
    }
    if (owned) {
      ledger = createMongoUsageLedger({ uri: env.MISSION_AI_LEDGER_MONGO_URI, dbName: 'MissionAI' });
      store = createMongoAcceptanceStore({ uri: env.MISSION_AI_LEDGER_MONGO_URI, dbName: 'MissionAI' });
    }
    const dashboard = await dashboardReader({ now });
    if (dashboard.timeZone !== 'America/Denver' ||
        monthStartFor(now, dashboard.timeZone).getTime() !==
        monthStartFor(new Date(now.getTime() + 120000), dashboard.timeZone).getTime()) {
      throw failure('acceptance_month_boundary');
    }
    before = await ledger.summary({ now, timeZone: dashboard.timeZone });
    const budget = requestBudget(dashboard, before);
    if (before.reservedUsd !== 0) throw failure('acceptance_pending_reservations');
    if (budget.projectedUsd + RESERVE_USD > budget.policy.hardUsd + 1e-9) {
      throw failure('monthly_hard_limit');
    }
    const reservationId = `paid-acceptance:${approvedRunId}`;
    await store.claim({ _id: approvedRunId, ...safe, stage: 'claimed',
      reservationId, createdAt: now, updatedAt: now,
      requestFingerprint: crypto.createHash('sha256')
        .update(JSON.stringify({ model, prompt: PROMPT, maxOutputTokens: OUTPUT_TOKENS,
          serviceTier })).digest('hex'),
    });
    claimed = true;
    reservationAttempted = true;
    reservation = await ledger.reserve({
      reservationId, reserveUsd: RESERVE_USD, directCapUsd: budget.directCapUsd,
      now, timeZone: dashboard.timeZone,
      metadata: { provider, model, role, task: 'paid_acceptance', project: 'mission-ai-acceptance' },
    });
    await store.markDispatch(approvedRunId, reservationId);
    let output;
    try {
      output = await executeProvider({
        provider, model, prompt: PROMPT, maxOutputTokens: OUTPUT_TOKENS,
        fetchImpl: async (url, options) => {
          let sent;
          try { sent = JSON.parse(options.body); } catch { throw failure('acceptance_provider_request_invalid'); }
          if (requestCount !== 0 || url !== PROVIDER_URLS[provider] || options.method !== 'POST' ||
              options.redirect !== 'error' || !isDeepStrictEqual(sent, anthropic ? {
                model, thinking: { type: 'between_tools' }, output_config: { effort: 'low' },
                max_tokens: OUTPUT_TOKENS, messages: [{ role: 'user', content: PROMPT }],
              } : { model, input: PROMPT, max_output_tokens: OUTPUT_TOKENS, service_tier: 'default' })) throw failure('acceptance_provider_request_invalid');
          requestCount += 1;
          const response = await fetchImpl(url, { ...options,
            ...(anthropic ? { body: JSON.stringify({ ...sent, service_tier: 'standard_only' }) } : {}),
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(20000)]),
          });
          if (!anthropic) return response;
          const body = await response.json();
          standardTierVerified = body?.usage?.service_tier === 'standard';
          return { ok: response.ok, status: response.status, json: async () => body };
        },
      });
      if (!standardTierVerified) throw new ProviderRequestError(provider, 502, 'provider_service_tier_unverified', { chargeUnknown: true });
      if (anthropic) output.serviceTier = 'standard';
      if (output.model !== model) {
        throw new ProviderRequestError(provider, 502, 'acceptance_model_mismatch', { chargeUnknown: true });
      }
      if (!output.text || output.usage.outputTokens === 0) {
        throw new ProviderRequestError(provider, 502, 'acceptance_output_missing', { chargeUnknown: true });
      }
    } catch (error) {
      const reason = safeReason(error, 'provider_request_failed');
      if (requestCount === 0 || error instanceof ProviderRequestError && !error.chargeUnknown) {
        await ledger.release({ reservationId, reason });
        return await finish(requestCount === 0 ? 'FAIL_PRE_DISPATCH' : 'FAIL_REJECTED', { reason });
      }
      await ledger.settle({ reservationId, actualUsd: RESERVE_USD,
        usage: { provider, model, estimated: true, reason, acceptanceRunId: approvedRunId },
      });
      const event = await store.readEvent(reservationId);
      if (event.status !== 'settled' || event.actualUsd !== RESERVE_USD || event.usage?.estimated !== true) {
        throw failure('acceptance_postcheck_failed');
      }
      return await finish('FAIL_ESTIMATED', { reason, estimated: true, accountedUsd: RESERVE_USD });
    }
    const cost = calculateUsageCost(provider, model, output.usage, pricing);
    const usage = { provider, model, ...output.usage, serviceTier: output.serviceTier,
      pricingVerifiedOn: cost.pricingVerifiedOn, estimated: false, acceptanceRunId: approvedRunId };
    await ledger.settle({ reservationId, actualUsd: cost.totalUsd, usage });
    const [event, after] = await Promise.all([
      store.readEvent(reservationId), ledger.summary({ now, timeZone: dashboard.timeZone }),
    ]);
    if (event.status !== 'settled' || event.reservedUsd !== RESERVE_USD ||
        event.actualUsd !== cost.totalUsd || !isDeepStrictEqual(event.usage, usage) ||
        event.metadata?.provider !== provider || event.metadata?.model !== model ||
        event.underestimated || after.accountingBlocked || after.reservedUsd !== before.reservedUsd ||
        Math.abs(after.settledUsd - before.settledUsd - cost.totalUsd) > 1e-9) {
      throw failure('acceptance_postcheck_failed');
    }
    return await finish('PASS_ACTUAL', { actualUsd: cost.totalUsd, estimated: false,
      serviceTier: output.serviceTier,
      inputTokens: output.usage.inputTokens, outputTokens: output.usage.outputTokens,
      cachedInputTokens: output.usage.cachedInputTokens, cacheWriteTokens: output.usage.cacheWriteTokens,
    });
  } catch (error) {
    const reason = safeReason(error, reservationAttempted ? 'accounting_pending' : 'preflight_failed');
    const status = reason === 'acceptance_already_claimed' ? 'SKIP_ALREADY_CLAIMED' :
      reason === 'reservation_underestimated' ? 'FAIL_RESERVATION_UNDERESTIMATED' :
        reservationAttempted ? 'FAIL_ACCOUNTING_PENDING' : 'FAIL_PRE_DISPATCH';
    return report(status, { reason });
  } finally {
    if (owned) await Promise.allSettled([ledger?.close(), store?.close()]);
  }
}

async function main() {
  const options = {};
  const flags = new Map([
    ['--approved-run-id', 'approvedRunId'], ['--approved-provider', 'approvedProvider'], ['--approved-model', 'approvedModel'],
    ['--approved-pricing-date', 'approvedPricingDate'], ['--approved-source-sha', 'approvedSourceSha'],
  ]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const field = flags.get(process.argv[index]);
    if (!field || !process.argv[index + 1] || Object.hasOwn(options, field)) {
      console.log(JSON.stringify({ status: 'FAIL_PRE_DISPATCH', reason: 'acceptance_arguments_invalid' }));
      process.exitCode = 2;
      return;
    }
    options[field] = process.argv[index + 1];
  }
  const watchdog = setTimeout(() => {
    console.log(JSON.stringify({ status: 'FAIL_ACCOUNTING_PENDING', reason: 'acceptance_watchdog' }));
    process.exit(124);
  }, 60000);
  try {
    const result = await runPaidAcceptance(options);
    console.log(JSON.stringify(result));
    process.exitCode = ['PASS_ACTUAL', 'SKIP_ALREADY_CLAIMED'].includes(result.status) ? 0 : 2;
  } finally {
    clearTimeout(watchdog);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.log(JSON.stringify({ status: 'FAIL_ACCOUNTING_PENDING', reason: 'acceptance_runner_failed' }));
    process.exitCode = 2;
  });
}
