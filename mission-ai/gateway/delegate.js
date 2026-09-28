import crypto from 'node:crypto';
import { configuredRouteRequest } from './route-api-v3.js';
import { fallbackTargets } from './fallbacks.js';
import { providerConfig } from './providers.js';
import { catalogModel } from './model-catalog.js';
import { modelOverride } from './model-overrides.js';
import { executeProvider, normalizeOutputTokenLimit, ProviderRequestError } from './provider-client.js';
import { queryCostDashboard } from './dashboard.js';
import { defaultUsageLedger } from './usage-ledger.js';
import { calculateUsageCost, loadPricing, maximumTextRequestCost } from './cost.js';
import { requestBudget } from './request-budget.js';

function delegationEnabled(value) {
  if (typeof value === 'boolean') return value;
  return String(process.env.MISSION_AI_DELEGATION_ENABLED || '').toLowerCase() === 'true';
}

function safeAttempt(target, model, status, error, costUsd) {
  return {
    provider: target.provider,
    role: target.role,
    model,
    status,
    ...(error ? { error } : {}),
    ...(Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

export async function delegateRequest({
  task,
  prompt,
  system = '',
  maxOutputTokens = 4096,
  project = 'unassigned',
  conversationId = '',
  fetchImpl = fetch,
  enabled,
  now = new Date(),
  dashboardReader = queryCostDashboard,
  usageLedger,
  pricingLoader = loadPricing,
} = {}) {
  if (!delegationEnabled(enabled)) throw new Error('delegation_disabled');
  if (!prompt || typeof prompt !== 'string') throw new Error('delegation_prompt_required');
  const outputLimit = normalizeOutputTokenLimit(maxOutputTokens);

  const conversationRef = conversationId
    ? crypto.createHash('sha256').update(String(conversationId)).digest('hex').slice(0, 16)
    : null;
  const safeProject = String(project || 'unassigned').slice(0, 200);

  const dashboard = await dashboardReader({ now });
  const ledger = usageLedger || defaultUsageLedger();
  if (typeof ledger.reconcileStaleReservations === 'function') {
    await ledger.reconcileStaleReservations({ now });
  }
  const ledgerSummary = await ledger.summary({ now, timeZone: dashboard.timeZone });
  const budget = requestBudget(dashboard, ledgerSummary);

  let routeDecision = await configuredRouteRequest({
    task,
    monthSpendUsd: budget.projectedUsd,
    budget: budget.policy,
  });
  if (!routeDecision.route || routeDecision.mode === 'blocked') {
    throw new Error('monthly_hard_limit');
  }

  const pricing = await pricingLoader();
  let role = routeDecision.routeName || 'primary';
  let targets = await fallbackTargets(role);
  const attempts = [];
  const directCapUsd = budget.directCapUsd;

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const provider = providerConfig(target.provider);
    const model =
      index === 0 && routeDecision.route.provider === target.provider
        ? routeDecision.route.model
        : modelOverride(target.role) || await catalogModel(target.provider, target.role);

    if (!provider?.hasApiKey || !model) {
      attempts.push(safeAttempt(target, model || null, 'skipped', 'provider_not_configured'));
      continue;
    }

    const reserveUsd = maximumTextRequestCost({
      provider: target.provider,
      model,
      prompt,
      system,
      maxOutputTokens: outputLimit,
      pricing,
    });

    const reservation = await ledger.reserve({
      reserveUsd,
      directCapUsd,
      now,
      timeZone: dashboard.timeZone,
      metadata: {
        provider: target.provider,
        model,
        role: target.role,
        task: String(task || 'chat'),
        project: safeProject,
        ...(conversationRef ? { conversationRef } : {}),
      },
    });

    try {
      const output = await executeProvider({
        provider: target.provider,
        model,
        prompt,
        system,
        maxOutputTokens: outputLimit,
        fetchImpl,
      });
      const cost = calculateUsageCost(target.provider, model, output.usage, pricing);
      await ledger.settle({
        reservationId: reservation.reservationId,
        actualUsd: cost.totalUsd,
        usage: {
          provider: target.provider,
          model,
          role: target.role,
          task: String(task || 'chat'),
          project: safeProject,
          ...(conversationRef ? { conversationRef } : {}),
          ...output.usage,
          pricingVerifiedOn: cost.pricingVerifiedOn,
        },
      });
      attempts.push(safeAttempt(target, model, 'succeeded', null, cost.totalUsd));
      const finalSummary = await ledger.summary({ now, timeZone: dashboard.timeZone });
      return {
        ok: true,
        task: String(task || 'chat'),
        role,
        mode: routeDecision.mode,
        selected: {
          provider: target.provider,
          role: target.role,
          model,
        },
        fallbackUsed: attempts.length > 1,
        attempts,
        cost,
        budget: {
          libreChatSpendUsd: budget.nativeUsd,
          delegatedSpendUsd: finalSummary.settledUsd,
          hardUsd: budget.policy.hardUsd,
        },
        output,
      };
    } catch (error) {
      if (!(error instanceof ProviderRequestError)) {
        throw error;
      }

      if (error.chargeUnknown) {
        await ledger.settle({
          reservationId: reservation.reservationId,
          actualUsd: reserveUsd,
          usage: {
            provider: target.provider,
            model,
            role: target.role,
            task: String(task || 'chat'),
            project: safeProject,
            ...(conversationRef ? { conversationRef } : {}),
            estimated: true,
            error: error.code,
          },
        });
        attempts.push(safeAttempt(target, model, 'failed', error.code, reserveUsd));
      } else {
        await ledger.release({ reservationId: reservation.reservationId, reason: error.code });
        attempts.push(safeAttempt(target, model, 'failed', error.code));
      }

      if (error.code === 'provider_input_invalid') throw error;
      const refreshedBudget = requestBudget(dashboard, await ledger.summary({ now, timeZone: dashboard.timeZone }));
      const refreshedRoute = await configuredRouteRequest({
        task,
        monthSpendUsd: refreshedBudget.projectedUsd,
        budget: refreshedBudget.policy,
      });
      if (!refreshedRoute.route || refreshedRoute.mode === 'blocked') throw new Error('monthly_hard_limit');
      if (refreshedRoute.routeName !== routeDecision.routeName) {
        role = refreshedRoute.routeName || 'primary';
        targets = (await fallbackTargets(role)).filter((candidate) =>
          !attempts.some((attempt) => attempt.provider === candidate.provider && attempt.role === candidate.role));
        index = -1;
      }
      routeDecision = refreshedRoute;
    }
  }

  const failure = new Error('delegate_all_providers_failed');
  failure.attempts = attempts;
  throw failure;
}
