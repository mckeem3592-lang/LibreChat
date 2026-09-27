import crypto from 'node:crypto';
import { configuredRouteRequest } from './route-api-v3.js';
import { fallbackTargets } from './fallbacks.js';
import { providerConfig } from './providers.js';
import { catalogModel } from './model-catalog.js';
import { modelOverride } from './model-overrides.js';
import { executeProvider, ProviderRequestError } from './provider-client.js';
import { queryCostDashboard } from './dashboard.js';
import { defaultUsageLedger } from './usage-ledger.js';
import { calculateUsageCost, loadPricing, maximumTextRequestCost } from './cost.js';

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

function uncertainCharge(error) {
  return (
    error instanceof ProviderRequestError &&
    (error.code === 'provider_timeout' || error.code === 'provider_network_error')
  );
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

  const conversationRef = conversationId
    ? crypto.createHash('sha256').update(String(conversationId)).digest('hex').slice(0, 16)
    : null;
  const safeProject = String(project || 'unassigned').slice(0, 200);

  const dashboard = await dashboardReader({ now });
  const ledger = usageLedger || defaultUsageLedger();
  const ledgerSummary = await ledger.summary({ now, timeZone: dashboard.timeZone });
  const settledSpendUsd = Number(dashboard.spendUsd || 0) + Number(ledgerSummary.settledUsd || 0);

  const routeDecision = await configuredRouteRequest({ task, monthSpendUsd: settledSpendUsd });
  if (!routeDecision.route || routeDecision.mode === 'blocked') {
    throw new Error('monthly_hard_limit');
  }

  const pricing = await pricingLoader();
  const role = routeDecision.routeName || 'primary';
  const targets = await fallbackTargets(role);
  const attempts = [];
  const directCapUsd = Math.max(0, Number(dashboard.hardUsd || 175) - Number(dashboard.spendUsd || 0));

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
      maxOutputTokens,
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
        maxOutputTokens,
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
        fallbackUsed: index > 0,
        attempts,
        cost,
        budget: {
          libreChatSpendUsd: Number(dashboard.spendUsd || 0),
          delegatedSpendUsd: Number(ledgerSummary.settledUsd || 0) + cost.totalUsd,
          hardUsd: Number(dashboard.hardUsd || 175),
        },
        output,
      };
    } catch (error) {
      if (!(error instanceof ProviderRequestError)) {
        await ledger.release({ reservationId: reservation.reservationId, reason: 'internal_error' });
        throw error;
      }

      if (uncertainCharge(error)) {
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
    }
  }

  const failure = new Error('delegate_all_providers_failed');
  failure.attempts = attempts;
  throw failure;
}
