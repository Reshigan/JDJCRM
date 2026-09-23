import { useQuery } from '@tanstack/react-query';
import type { Role } from '@baton/core';

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const form = opts.body instanceof FormData;
  const r = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: opts.body && !form ? { 'content-type': 'application/json' } : undefined,
    body: form ? (opts.body as FormData) : opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw Object.assign(new Error(data?.error ?? r.statusText), { status: r.status });
  return data;
}

export type Me = { id: string; name: string; email: string; role: Role; department_id: number | null; mfa_enabled: boolean; mfa_ok: boolean };
export const useMe = () => useQuery<Me>({ queryKey: ['me'], queryFn: () => api('/me'), retry: false, staleTime: 60_000 });

export type Lookups = {
  departments: { id: number; code: string; name: string }[];
  sites: { id: number; code: string; name: string; region: string }[];
  categories: { id: number; name: string; department_ids: number[]; clock: 'business' | 'wall'; limit_critical: number; limit_high: number; limit_normal: number }[];
  organisations: { id: number; kind: 'practice' | 'hospital'; name: string; site_id: number | null }[];
  users: { id: string; name: string; role: Role; department_id: number }[];
  thresholds: [number, number, number];
};
export const useLookups = () => useQuery<Lookups>({ queryKey: ['lookups'], queryFn: () => api('/lookups'), staleTime: 300_000 });

/** Uncontrolled forms: read values straight from the DOM. */
export const formValues = (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
};
