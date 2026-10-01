import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeTool, REPOSITORY, TOOLS } from './bridge.mjs';

test('only the Mission Program Hub repository and three reviewed tools are accepted', () => {
  assert.equal(REPOSITORY, 'mckeem3592-lang/mission-program-hub');
  for (const name of TOOLS) {
    const args = { owner: 'mckeem3592-lang', repo: 'mission-program-hub' };
    assert.equal(authorizeTool(name, args), args);
    assert.throws(() => authorizeTool(name, { ...args, repo: 'LibreChat' }));
    assert.throws(() => authorizeTool(name, { ...args, owner: 'someone-else' }));
  }
  assert.throws(() => authorizeTool('delete_repository', {
    owner: 'mckeem3592-lang', repo: 'mission-program-hub',
  }));
  assert.throws(() => authorizeTool('push_files', null));
});
