import assert from 'node:assert/strict';
import test from 'node:test';
import { missionAiOwnerMatches } from './owner-scope.ts';
const owner='0123456789abcdef01234567';
const settings={MISSION_AI_CODE_OWNER_ID:owner,CODEAPI_JWT_SINGLE_TENANT_ID:'mission-ai-chat-test'};
test('only the configured owner in the fixed tenant is accepted',()=>{
  assert.equal(missionAiOwnerMatches(owner,'mission-ai-chat-test',settings),true);
  for(const user of ['000000000000000000000000',undefined,null,{},owner.toUpperCase()])
    assert.equal(missionAiOwnerMatches(user,'mission-ai-chat-test',settings),false);
  for(const tenant of ['other','legacy','',undefined,null])
    assert.equal(missionAiOwnerMatches(owner,tenant,settings),false);
});
test('missing or invalid deployment binding fails closed',()=>{
  for(const bad of [{},{...settings,MISSION_AI_CODE_OWNER_ID:''},{...settings,MISSION_AI_CODE_OWNER_ID:'invalid'},{...settings,CODEAPI_JWT_SINGLE_TENANT_ID:'other'}])
    assert.equal(missionAiOwnerMatches(owner,'mission-ai-chat-test',bad),false);
});
