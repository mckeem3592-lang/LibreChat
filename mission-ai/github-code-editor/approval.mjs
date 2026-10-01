/** Require an explicit LibreChat approval even if a user selects bypass mode. */
export default function githubEditorApproval() {
  return () => async (input) => {
    const name = String(input?.toolName ?? '');
    if (name.includes('github-code-editor') &&
        (name.includes('push_files') || name.includes('create_branch'))) {
      return { decision: 'ask', reason: 'Review the Mission Program Hub GitHub change.' };
    }
    return {};
  };
}
