// Subscribes to server-sent change events and refreshes only the affected queries.
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const KEYS: Record<string, string[][]> = {
  ticket: [['tickets'], ['ticket'], ['live'], ['analytics']],
  bleed: [['bleeds'], ['bleed'], ['live'], ['field'], ['samples'], ['analytics']],
  bleed_request: [['bleeds'], ['bleed'], ['live'], ['field']],
};

export function useLiveEvents(enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/stream');
    const pending = new Set<string>();
    let t: ReturnType<typeof setTimeout> | undefined;
    const flush = () => { for (const k of pending) qc.invalidateQueries({ queryKey: JSON.parse(k) }); pending.clear(); };
    const queue = (keys: string[][]) => { keys.forEach((k) => pending.add(JSON.stringify(k))); clearTimeout(t); t = setTimeout(flush, 250); };
    es.addEventListener('change', (e) => queue(KEYS[JSON.parse((e as MessageEvent).data).entity] ?? []));
    es.addEventListener('notification', () => queue([['notifications']]));
    return () => { clearTimeout(t); es.close(); };
  }, [enabled, qc]);
}
