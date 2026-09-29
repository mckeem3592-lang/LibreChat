import { renderHook } from '@testing-library/react';
import useGetAgentsConfig from '../useGetAgentsConfig';
import { useGetEndpointsQuery } from '~/data-provider';
jest.mock('~/data-provider', () => ({ useGetEndpointsQuery: jest.fn() }));
const query = useGetEndpointsQuery as jest.Mock;
it('uses owner inline metadata when saved agents are disabled', () => {
  const inlineAgents = { capabilities: ['execute_code', 'stateful_code_sessions'], statefulCodeSessions: { environments: [{ id: 'attached-workers', type: 'attached' }] } };
  query.mockReturnValue({ data: { MissionAI: { inlineAgents } } });
  const { result } = renderHook(() => useGetAgentsConfig());
  expect(result.current.agentsConfig).toEqual(inlineAgents);
  expect(result.current.endpointsConfig).not.toHaveProperty('agents');
});
it('does not infer workspace access without advertised metadata', () => {
  query.mockReturnValue({ data: { MissionAI: {} } });
  const { result } = renderHook(() => useGetAgentsConfig());
  expect(result.current.agentsConfig).toBeNull();
});
