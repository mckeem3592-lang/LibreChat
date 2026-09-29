import { atom, useAtom } from 'jotai';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { Gauge, X } from 'lucide-react';
import { apiBaseUrl, request } from 'librechat-data-provider';
import { Button, Input, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { useAuthContext } from '~/hooks/AuthContext';
import { useGetEndpointsQuery } from '~/data-provider/Endpoints/queries';

const openAtoms = { right: atom(false), bottom: atom(false) };
const queryAtom = atom('');
interface Status {
  budget: { spendUsd: number; reservedUsd: number; projectedSpendUsd: number;
    targetUsd: number; economyUsd: number; hardUsd: number };
  flags: { paidText: boolean; delegation: boolean; images: boolean; freeSearch: boolean };
  accountingBlocked: boolean;
}
interface SearchResults {
  credits: number;
  remainingCredits: number;
  results: { title: string; url: string; content: string }[];
}
const endpoint = (path: string) => `${apiBaseUrl()}/api/mission-ai/${path}`;
const dollars = (value: number) => new Intl.NumberFormat(undefined, {
  style: 'currency', currency: 'USD', maximumFractionDigits: 7,
}).format(value);

/** Same owner login, server-held credentials, no background model calls. */
export default function MissionControl({ side = 'right' }: { side?: 'right' | 'bottom' }) {
  const localize = useLocalize();
  const { user, isAuthenticated } = useAuthContext();
  const { data: endpoints } = useGetEndpointsQuery();
  const [open, setOpen] = useAtom(openAtoms[side]);
  const [query, setQuery] = useAtom(queryAtom);
  const capabilities = useQuery({
    queryKey: ['mission-ai-capabilities', user?.id],
    queryFn: () => request.get<{ enabled: boolean }>(endpoint('capabilities')),
    enabled: isAuthenticated && endpoints?.MissionAI != null,
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false,
  });
  const status = useQuery({
    queryKey: ['mission-ai-status', user?.id], queryFn: () => request.get<Status>(endpoint('status')),
    enabled: isAuthenticated && open && capabilities.data?.enabled === true,
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false,
  });
  const search = useMutation({
    mutationFn: (text: string): Promise<SearchResults> => request.post(endpoint('search'), { query: text, maxResults: 5 }),
    retry: false,
  });
  if (!isAuthenticated || capabilities.data?.enabled !== true) return null;
  const data = status.data;
  return (
    <>
      <TooltipAnchor side={side} description={localize('com_mission_control')} render={
        <Button variant="ghost" size="icon" className="h-9 w-9 flex-shrink-0"
          aria-label={localize('com_mission_control')} onClick={() => setOpen(true)}>
          <Gauge className="h-5 w-5 text-text-primary" aria-hidden="true" />
        </Button>
      } />
      <Dialog open={open} onClose={() => setOpen(false)} className="relative z-50">
        <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border-light bg-surface-dialog p-6 text-text-primary shadow-2xl">
            <div className="mb-5 flex items-center justify-between">
              <DialogTitle className="text-xl font-semibold">{localize('com_mission_control')}</DialogTitle>
              <Button variant="ghost" size="icon" aria-label={localize('com_ui_close')}
                onClick={() => setOpen(false)}><X aria-hidden="true" className="h-5 w-5" /></Button>
            </div>
            <p className="mb-4 text-sm text-text-secondary">{localize('com_mission_legacy_boundary')}</p>
            {status.isFetching && <p role="status">{localize('com_mission_loading')}</p>}
            {status.isError && <p role="alert">{localize('com_mission_unavailable')}</p>}
            {data && <>
              <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border-light p-4">
                <div><dt className="text-sm text-text-secondary">{localize('com_mission_spend')}</dt><dd className="text-xl font-semibold">{dollars(data.budget.spendUsd)}</dd></div>
                <div><dt className="text-sm text-text-secondary">{localize('com_mission_reserved')}</dt><dd className="text-xl font-semibold">{dollars(data.budget.reservedUsd)}</dd></div>
                <div><dt>{localize('com_mission_target')}</dt><dd>{dollars(data.budget.targetUsd)}</dd></div>
                <div><dt>{localize('com_mission_hard_limit')}</dt><dd>{dollars(data.budget.hardUsd)}</dd></div>
              </dl>
              <p className="mt-4 text-sm">{localize(data.flags.paidText ? 'com_mission_paid_enabled' : 'com_mission_paid_off')}</p>
              {data.accountingBlocked && <p role="alert">{localize('com_mission_accounting_blocked')}</p>}
              <p className="mt-2 text-sm text-text-secondary">{localize('com_mission_model_policy')}</p>
              <form className="mt-6 space-y-3" onSubmit={(event) => { event.preventDefault(); if (query.trim() && !search.isLoading && data.flags.freeSearch) search.mutate(query.trim()); }}>
                <label htmlFor="mission-search" className="block font-semibold">{localize('com_mission_search')}</label>
                <p className="text-sm text-text-secondary">{localize('com_mission_search_cost')}</p>
                <Input id="mission-search" value={query} maxLength={2000}
                  onChange={(event) => setQuery(event.target.value)} disabled={!data.flags.freeSearch || search.isLoading} />
                <Button type="submit" disabled={!query.trim() || !data.flags.freeSearch || search.isLoading}>
                  {localize(search.isLoading ? 'com_mission_searching' : 'com_mission_search')}
                </Button>
                {!data.flags.freeSearch && <p role="status">{localize('com_mission_search_off')}</p>}
                {search.isError && <p role="alert">{localize('com_mission_search_failed')}</p>}
              </form>
            </>}
            <div aria-live="polite" className="mt-4 space-y-4">
              {search.data && <p className="text-sm">{localize('com_mission_search_remaining', { count: search.data.remainingCredits })}</p>}
              {search.data?.results.map((result, index) => (
                <article key={`${result.url}-${index}`} className="rounded-lg border border-border-light p-4">
                  <a href={result.url} target="_blank" rel="noopener noreferrer" className="font-semibold underline">{result.title}</a>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-text-secondary">{result.content}</p>
                </article>
              ))}
            </div>
            <Button variant="outline" className="mt-5" disabled={status.isFetching}
              onClick={() => status.refetch()}>{localize('com_mission_refresh')}</Button>
          </DialogPanel>
        </div>
      </Dialog>
    </>
  );
}
