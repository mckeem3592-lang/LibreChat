/** Bind managed ephemeral coding to the existing named Mac workspace. No cloud fallback. */
export function managedWorkspaceBinding(input: {
  endpoint: string;
  enabled: boolean;
  toolsEnabled: boolean;
  executeCode: boolean;
  ownerEmail?: string;
  userEmail?: string;
  body?: unknown;
  environments?: unknown;
}) {
  if (!input.enabled || !input.toolsEnabled || input.endpoint !== 'MissionAI' || !input.executeCode) {
    return undefined;
  }
  const fail = () => { throw new Error('Mission AI requires the approved attached coding workspace'); };
  if (!input.ownerEmail || !input.userEmail || input.ownerEmail.toLowerCase() !== input.userEmail.toLowerCase()) fail();
  const body = input.body as { codeWorkspaces?: unknown; codeEnvironmentMode?: unknown; codeApprovalMode?: unknown } | undefined;
  const selected = body?.codeWorkspaces;
  if (!Array.isArray(selected) || selected.length !== 1 || body?.codeEnvironmentMode !== 'attached' || body?.codeApprovalMode !== 'ask') fail();
  const workspace = (selected as Array<{ environmentId?: unknown; workspaceId?: unknown }>)[0];
  if (workspace?.environmentId !== 'attached-workers' || workspace.workspaceId !== 'primary') fail();
  const environments = input.environments;
  if (!Array.isArray(environments) || environments.length !== 1) fail();
  const environment = (environments as Array<{ id?: unknown; type?: unknown; baseURL?: unknown }>)[0];
  if (environment?.id !== 'attached-workers' || environment.type !== 'attached' ||
      environment.baseURL !== 'https://mission-ai-code-api-mckee.onrender.com/v1') fail();
  return {
    stateful_code_sessions: true,
    stateful_code_environment: 'conversation' as const,
    code_environment_id: 'attached-workers',
    code_workspace_id: 'primary',
  };
}
