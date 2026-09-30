import { act, renderHook } from '@testing-library/react';
import useMissionGatewayHeartbeat from './useMissionGatewayHeartbeat';

const CHAT_HOST = 'mission-ai-chat-test-mckee.onrender.com';

describe('Mission AI open-page heartbeat', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('keeps chat and gateway warm while open, then stops after unmount', async () => {
    const { unmount } = renderHook(() => useMissionGatewayHeartbeat(CHAT_HOST));
    expect(global.fetch).toHaveBeenCalledWith('/health', {
      cache: 'no-store', credentials: 'same-origin',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://mission-ai-gateway-mckee.onrender.com/health',
      { mode: 'no-cors', cache: 'no-store', credentials: 'omit' },
    );
    await act(async () => { await Promise.resolve(); });
    act(() => { jest.advanceTimersByTime(4 * 60 * 1000); });
    expect(global.fetch).toHaveBeenCalledTimes(4);
    await act(async () => { await Promise.resolve(); });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(global.fetch).toHaveBeenCalledTimes(6);
    unmount();
    act(() => { jest.advanceTimersByTime(4 * 60 * 1000); });
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });

  it('does not contact either service from another LibreChat host', () => {
    renderHook(() => useMissionGatewayHeartbeat('other.example.com'));
    act(() => { jest.advanceTimersByTime(8 * 60 * 1000); });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
