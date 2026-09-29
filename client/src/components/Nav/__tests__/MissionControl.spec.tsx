/* eslint-disable i18next/no-literal-string */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider } from 'jotai';
import { request } from 'librechat-data-provider';
import MissionControl, { missionCostReport } from '../MissionControl';

let mockMissionAvailable = true;
jest.mock('~/data-provider/Endpoints/queries', () => ({ useGetEndpointsQuery: () => ({
  data: mockMissionAvailable ? { MissionAI: {} } : {},
}) }));

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) =>
  require('~/locales/en/translation.json')[key] }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: { id: 'fixture-owner' }, isAuthenticated: true }) }));
jest.mock('librechat-data-provider', () => ({ ...jest.requireActual('librechat-data-provider'),
  apiBaseUrl: () => '', request: { get: jest.fn(), post: jest.fn() } }));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => <>{content}</>,
}));
const status = {
  budget: { spendUsd: .069006775, reservedUsd: 0, projectedSpendUsd: .069006775, targetUsd: 100, economyUsd: 125, hardUsd: 175 },
  flags: { paidText: false, delegation: false, images: false, freeSearch: false }, accountingBlocked: false,
};
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  return render(<Provider><QueryClientProvider client={client}><MissionControl /></QueryClientProvider></Provider>);
}
beforeEach(() => { jest.clearAllMocks(); mockMissionAvailable = true; });
it('does not add control requests to a chat without the Mission AI endpoint', () => {
  mockMissionAvailable = false;
  mount();
  expect(request.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Mission AI controls' })).not.toBeInTheDocument();
});
it('shows recorded spending and prevents disabled free-search requests', async () => {
  (request.get as jest.Mock).mockImplementation((url: string) => Promise.resolve(url.endsWith('capabilities') ? { enabled: true } : status));
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Mission AI controls' }));
  expect(await screen.findByText('$0.0690068')).toBeInTheDocument();
  expect(screen.getByText('Paid text requests are off.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Free web search' })).toBeDisabled();
  expect(request.post).not.toHaveBeenCalled();
});
it('renders free-search sources as text and opens external links securely', async () => {
  (request.get as jest.Mock).mockImplementation((url: string) => Promise.resolve(url.endsWith('capabilities') ? { enabled: true } : { ...status, flags: { ...status.flags, freeSearch: true } }));
  (request.post as jest.Mock).mockResolvedValue({ credits: 1, remainingCredits: 8,
    results: [{ title: 'Official source', url: 'https://example.test/reference', content: '<script>not executable</script>' }] });
  mount(); await userEvent.click(await screen.findByRole('button', { name: 'Mission AI controls' }));
  await userEvent.type(await screen.findByRole('textbox', { name: 'Free web search' }), 'fixture query');
  await userEvent.click(screen.getByRole('button', { name: 'Free web search' }));
  const link = await screen.findByRole('link', { name: 'Official source' });
  expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText('<script>not executable</script>')).toBeInTheDocument();
  expect(request.post).toHaveBeenCalledTimes(1);
});

it('shows calendar spend and monthly categories without hiding estimates or triggering model calls', async () => {
  const detail = { ...status, periods: { todayUsd: .1, weekUsd: .3,
    todayEstimatedUsd: .05, weekEstimatedUsd: .05, monthUnallocatedUsd: .003144, timeZone: 'America/Denver' },
    byProvider: [{ provider: 'anthropic', spendUsd: .1 }],
    byModel: [{ model: 'fixture-model', spendUsd: .1 }],
    byProject: [{ project: '<script>owner project</script>', spendUsd: .1 }],
    byTask: [] };
  (request.get as jest.Mock).mockImplementation((url: string) => Promise.resolve(url.endsWith('capabilities') ? { enabled: true } : detail));
  mount(); await userEvent.click(await screen.findByRole('button', { name: 'Mission AI controls' }));
  expect(await screen.findByText('Today, recorded spend')).toBeInTheDocument();
  expect(screen.getByText('This week, recorded spend')).toBeInTheDocument();
  expect(screen.getByText(/^This week includes retained estimates of/)).toBeInTheDocument();
  expect(screen.getByText('<script>owner project</script>')).toBeInTheDocument();
  expect(screen.getByRole('table', { name: 'Cost by provider' })).toBeInTheDocument();
  expect(screen.getByText('No recorded costs.')).toBeInTheDocument();
  expect(request.post).not.toHaveBeenCalled();
});

it('exports observed costs without private payloads, monthly savings claims or extra requests', () => {
  const report = missionCostReport({ ...status,
    byProject: [{ project: 'owner project', spendUsd: .025518 }],
    privateToken: 'must-not-export', conversation: 'must-not-export',
  } as typeof status, '2026-09-29T16:00:00.000Z');
  expect(report.recordedSpendUsd).toBe(status.budget.spendUsd);
  expect(report.pendingReservationsUsd).toBe(0);
  expect(report.monthlyBreakdowns.project).toEqual([{ category: 'owner project', spendUsd: .025518 }]);
  expect(report.representativeWorkloadComplete).toBe(false);
  expect(JSON.stringify(report)).not.toContain('must-not-export');
  expect(JSON.stringify(report)).not.toContain('annualized');
  expect(request.get).not.toHaveBeenCalled(); expect(request.post).not.toHaveBeenCalled();
});
