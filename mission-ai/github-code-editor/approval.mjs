/** Require an explicit LibreChat approval even if a user selects bypass mode. */
export default function githubEditorApproval() {
  return () => async (input) => {
    const name = String(input?.toolName ?? '');
    if (name.includes('github-code-editor') &&
        (name.includes('push_files') || name.includes('create_branch'))) {
      return { decision: 'ask', reason: 'Review the Mission Program Hub GitHub change.' };
    }
    if (name.includes('mission-ai-device') &&
        !['mission_readiness', 'browser_list_tabs', 'browser_get_state', 'file_list'].some((tool) => name.endsWith(tool))) {
      return { decision: 'ask', reason: 'Review the Mission AI device action.' };
    }
    return {};
  };
}
