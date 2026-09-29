import test from 'node:test';
import assert from 'node:assert/strict';
import { managedWorkspaceBinding } from './generated/managedWorkspace.js';
const valid = {
  endpoint: 'MissionAI', enabled: true, toolsEnabled: true, executeCode: true,
  ownerEmail: 'owner@synthetic.invalid', userEmail: 'OWNER@synthetic.invalid',
  body: { codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }],
    codeEnvironmentMode: 'attached', codeApprovalMode: 'ask' },
  environments: [{ id: 'attached-workers', type: 'attached', baseURL: 'https://mission-ai-code-api-mckee.onrender.com/v1' }],
};
test('inline coding uses the existing named Mac workspace without a cloud environment', () => {
  assert.deepEqual(managedWorkspaceBinding(valid), { stateful_code_sessions: true,
    stateful_code_environment: 'conversation', code_environment_id: 'attached-workers', code_workspace_id: 'primary' });
});
test('text, disabled tools, and original custom endpoints retain their existing agent behavior', () => {
  for (const override of [{executeCode:false},{enabled:false},{toolsEnabled:false},{endpoint:'OriginalChat'}]) {
    assert.equal(managedWorkspaceBinding({...valid,...override}),undefined);
  }
});
test('coding refuses missing selection, cloud opt-out, other workspaces and relaxed approval', () => {
  for (const body of [undefined, {}, {...valid.body,codeWorkspaces:[]},
    {...valid.body,codeEnvironmentMode:'without_attached'}, {...valid.body,codeApprovalMode:'fullAccess'},
    {...valid.body,codeWorkspaces:[{environmentId:'attached-workers',workspaceId:'other'}]},
    {...valid.body,codeWorkspaces:[{environmentId:'cloud',workspaceId:'primary'}]}]) {
    assert.throws(()=>managedWorkspaceBinding({...valid,body}));
  }
});
test('coding refuses other owners and changed or missing attached service configuration', () => {
  for (const override of [{ownerEmail:undefined},{userEmail:undefined},{userEmail:'other@synthetic.invalid'},
    {environments:[]},{environments:[{...valid.environments[0],type:'cloud'}]},
    {environments:[{...valid.environments[0],baseURL:'https://untrusted.invalid/v1'}]}]) {
    assert.throws(()=>managedWorkspaceBinding({...valid,...override}));
  }
});
