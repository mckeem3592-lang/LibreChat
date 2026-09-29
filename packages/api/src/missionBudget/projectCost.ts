type Json = Record<string, unknown>;
/** Server-side attribution after the project ownership guard; never add project data to prompts. */
export function attachManagedProjectCost(config: Json, options: {
  enabled: boolean; gatewayURL?: string; projectId?: unknown;
}): void {
  if (!options.enabled) return;
  if (options.projectId != null && (typeof options.projectId !== 'string' ||
      !/^[a-fA-F0-9]{24}$/.test(options.projectId))) throw new Error('managed_project_invalid');
  const client = config.clientOptions as Json | undefined;
  const gateway = new URL(options.gatewayURL ?? '');
  if (!client || client.baseURL !== `${gateway.origin}/native/anthropic`) throw new Error('managed_project_transport_invalid');
  const previous = client.defaultHeaders as Json | undefined;
  const headers = Object.fromEntries(Object.entries(previous ?? {}).filter(([key]) => key.toLowerCase() !== 'x-mission-ai-project'));
  if (options.projectId != null) headers['x-mission-ai-project'] = options.projectId;
  config.clientOptions = { ...client, defaultHeaders: headers };
}
