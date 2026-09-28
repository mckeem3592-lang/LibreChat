import { requireManualApproval } from './approval-gate.js';

const readOnlyOperations = new Set(['read_file', 'list_files', 'search_text', 'preview_edit', 'read_repository_instructions']);

export async function requireCodeApproval(assignment, options = {}) {
  const request = assignment.request;
  // An action name cannot preview its resolved command, nor an implicit checkout's file changes.
  if (request?.environmentAction !== undefined || request?.workspaceInstanceId !== undefined ||
      request?.body?.workspace_instance_id !== undefined) throw new Error('local_approval_unsupported');
  // Dynamic workspace provisioning can mutate files even for an eventual read.
  if (assignment.executionKind === 'workspace_tool' &&
      readOnlyOperations.has(request?.operation)) return;
  await requireManualApproval(`code.${assignment.executionKind}`, { request }, options);
}
