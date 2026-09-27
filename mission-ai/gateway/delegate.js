import { configuredRouteRequest } from './route-api-v3.js';
import { fallbackTargets } from './fallbacks.js';
import { providerConfig } from './providers.js';
import { catalogModel } from './model-catalog.js';
import { modelOverride } from './model-overrides.js';
import { executeProvider, ProviderRequestError } from './provider-client.js';

function delegationEnabled(value) {
  if (typeof value === 'boolean') return value;
  return String(process.env.MISSION_AI_DELEGATION_ENABLED || '').toLowerCase() === 'true';
}

function safeAttempt(target, model, status, error) {
  return {
    provider: target.provider,
    role: target.role,
    model,
    status,
    ...(error ? { error } : {}),
  };
}

export async function delegateRequest({
  task,
  monthSpendUsd,
  prompt,
  system = '',
  maxOutputTokens = 4096,
  fetchImpl = fetch,
  enabled,
} = {}) {
  if (!delegationEnabled(enabled)) throw new Error('delegation_disabled');
  if (!prompt || typeof prompt !== 'string') throw new Error('delegation_prompt_required');

  const routeDecision = await configuredRouteRequest({ task, monthSpendUsd });
  if (!routeDecision.route || routeDecision.mode === 'blocked') {
    throw new Error('monthly_hard_limit');
  }

  const role = routeDecision.routeName || 'primary';
  const targets = await fallbackTargets(role);
  const attempts = [];

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

    try {
      const output = await executeProvider({
        provider: target.provider,
        model,
        prompt,
        system,
        maxOutputTokens,
        fetchImpl,
      });
      attempts.push(safeAttempt(target, model, 'succeeded'));
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
        output,
      };
    } catch (error) {
      if (!(error instanceof ProviderRequestError)) throw error;
      attempts.push(safeAttempt(target, model, 'failed', error.code));
      if (error.code === 'provider_input_invalid') throw error;
    }
  }

  const failure = new Error('delegate_all_providers_failed');
  failure.attempts = attempts;
  throw failure;
}
