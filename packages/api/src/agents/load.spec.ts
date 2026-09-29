import { EModelEndpoint, parseEphemeralAgentId } from 'librechat-data-provider';
import type { LoadAgentDeps } from './load';
import { loadEphemeralAgent } from './load';
import { resolveSender } from './sender';

const deps: LoadAgentDeps = {
  getAgent: async () => null,
  getMCPServerTools: async () => null,
};

const baseReq = {
  user: { id: 'user-1' },
  config: {
    modelSpecs: { list: [{ name: 'my-opus-spec', label: 'Spec Label' }] },
  },
  body: {},
} as unknown as Parameters<typeof loadEphemeralAgent>[0]['req'];

async function idFor(modelParameters: Record<string, unknown>) {
  const agent = await loadEphemeralAgent(
    {
      req: baseReq,
      spec: 'my-opus-spec',
      endpoint: 'my-custom-endpoint',
      model_parameters: modelParameters as never,
    },
    deps,
  );
  return agent?.id;
}

/**
 * Documents the #14253 Bug 2 mechanism: the ephemeral agent id (LangGraph node /
 * HITL checkpoint namespace) is derived from `sender = modelLabel ?? modelSpec.label`.
 * When the resume drops `modelLabel`, the id drifts and the paused checkpoint can't be
 * re-entered. The fix keeps `modelLabel` across resume (RESUME_CONTEXT_KEYS), so the
 * original and resumed ids stay equal.
 */
describe('loadEphemeralAgent ephemeral id stability (#14253 Bug 2)', () => {
  test('id changes when modelLabel is lost vs preserved', async () => {
    const withLabel = await idFor({ model: 'claude-opus-4', modelLabel: 'My Opus' });
    const withoutLabel = await idFor({ model: 'claude-opus-4' });
    expect(withLabel).toBeTruthy();
    expect(withoutLabel).toBeTruthy();
    // Original turn (has modelLabel) vs a resume that dropped it → different namespace.
    expect(withLabel).not.toEqual(withoutLabel);
  });

  test('id is stable when modelLabel is preserved across turns', async () => {
    const a = await idFor({ model: 'claude-opus-4', modelLabel: 'My Opus' });
    const b = await idFor({ model: 'claude-opus-4', modelLabel: 'My Opus' });
    expect(a).toEqual(b);
  });
});

/** Custom endpoints carry their configured name in `endpoint` at runtime,
 *  which `TEndpointOption` types as `EModelEndpoint`. */
const customEndpointOption = {
  endpoint: 'my-custom-endpoint' as EModelEndpoint,
  model: 'claude-opus-4',
};

describe('Mission AI inline attached coding', () => {
  const originalEnv = process.env;
  beforeAll(() => {
    process.env = { ...originalEnv, MISSION_AI_MANAGED_CHAT: 'true',
      MISSION_AI_MANAGED_TOOLS: 'true', MISSION_AI_CONTROL_OWNER_EMAIL: 'owner@synthetic.invalid' };
  });
  afterAll(() => { process.env = originalEnv; });
  const codingRequest = () => ({
    user: { id: 'synthetic-owner', email: 'owner@synthetic.invalid' },
    config: { endpoints: {
      custom: [{ name: 'MissionAI', models: { default: ['claude-sonnet-5-5'] } }],
      agents: { statefulCodeSessions: { environments: [{ id: 'attached-workers', type: 'attached',
        baseURL: 'https://mission-ai-code-api-mckee.onrender.com/v1' }] } },
    } },
    body: { ephemeralAgent: { execute_code: true }, codeEnvironmentMode: 'attached',
      codeApprovalMode: 'ask', codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }] },
  });
  test('the actual ephemeral agent loader binds coding to the named attached workspace', async () => {
    const agent = await loadEphemeralAgent({ req: codingRequest() as never, endpoint: 'MissionAI',
      model_parameters: { model: 'claude-sonnet-5-5' } as never }, deps);
    expect(agent).toMatchObject({ stateful_code_sessions: true, stateful_code_environment: 'conversation',
      code_environment_id: 'attached-workers', code_workspace_id: 'primary' });
  });
  test('missing selection fails before any model or cloud code request', async () => {
    const req = codingRequest(); req.body.codeWorkspaces = [];
    await expect(loadEphemeralAgent({ req: req as never, endpoint: 'MissionAI',
      model_parameters: { model: 'claude-sonnet-5-5' } as never }, deps)).rejects.toThrow('approved attached coding workspace');
  });
  test('text-only Mission AI agents do not receive coding access', async () => {
    const req = codingRequest(); req.body.ephemeralAgent.execute_code = false;
    const agent = await loadEphemeralAgent({ req: req as never, endpoint: 'MissionAI',
      model_parameters: { model: 'claude-sonnet-5-5' } as never }, deps);
    expect(agent?.code_environment_id).toBeUndefined();
    expect(agent?.stateful_code_sessions).toBeUndefined();
  });
});

describe('loadEphemeralAgent → resolveSender parity', () => {
  test('the persisted sender matches the spec label encoded into the agent id', async () => {
    const agent = await loadEphemeralAgent(
      {
        req: baseReq,
        spec: 'my-opus-spec',
        endpoint: 'my-custom-endpoint',
        model_parameters: { model: 'claude-opus-4' } as never,
      },
      deps,
    );
    expect(agent?.id).toBeTruthy();
    const sender = resolveSender({
      agent: { id: agent?.id },
      specLabel: 'Spec Label',
      endpointOption: customEndpointOption,
    });
    expect(sender).toBe('Spec Label');
    expect(sender).toBe(parseEphemeralAgentId(agent?.id ?? '')?.sender);
  });

  test('a user modelLabel wins over the spec label in the persisted sender', async () => {
    const agent = await loadEphemeralAgent(
      {
        req: baseReq,
        spec: 'my-opus-spec',
        endpoint: 'my-custom-endpoint',
        model_parameters: { model: 'claude-opus-4', modelLabel: 'My Opus' } as never,
      },
      deps,
    );
    const sender = resolveSender({
      agent: { id: agent?.id },
      specLabel: 'Spec Label',
      endpointOption: { ...customEndpointOption, modelLabel: 'My Opus' },
    });
    expect(sender).toBe('My Opus');
    expect(sender).toBe(parseEphemeralAgentId(agent?.id ?? '')?.sender);
  });
});
