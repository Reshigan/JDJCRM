// Offline outbox for the field app (brief §6.6 no network coverage).
// Actions carry the device time they happened; the server keeps that time and flags late syncs.
import { useEffect, useState } from 'react';

type Meta = { kind: 'arrive'; request_id: string } | { kind: 'capture'; bleed_id: string; outcome: string } | { kind: 'file'; bleed_ids: string[] };
type Item = { id?: number; url: string; json?: unknown; form?: [string, string | Blob][]; meta: Meta; created: number };
type Failed = { meta: Meta; error: string };

const open = () =>
  new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('baton-field', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      r.result.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await open();
  return new Promise<T>((res, rej) => {
    const r = fn(db.transaction(store, mode).objectStore(store));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export const kvGet = <T>(k: string) => tx<T>('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k: string, v: unknown) => tx('kv', 'readwrite', (s) => s.put(v, k));
const all = () => tx<Item[]>('outbox', 'readonly', (s) => s.getAll());
const remove = (id: number) => tx('outbox', 'readwrite', (s) => s.delete(id));

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
let failed: Failed[] = [];

class HttpFail extends Error {}

async function post(it: Item) {
  let body: BodyInit;
  let headers: HeadersInit | undefined;
  if (it.form) {
    const fd = new FormData();
    for (const [k, v] of it.form) fd.append(k, v);
    body = fd;
  } else {
    body = JSON.stringify(it.json);
    headers = { 'content-type': 'application/json' };
  }
  const r = await fetch(it.url, { method: 'POST', body, headers, credentials: 'same-origin' }); // throws TypeError when offline
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new HttpFail(d.error ?? r.statusText);
  }
}

/** Try now; if the network is down, keep it in the outbox. Server-side rejections are surfaced, not queued. */
export async function send(it: Omit<Item, 'created'>): Promise<'sent' | 'queued'> {
  const item = { ...it, created: Date.now() };
  if (!navigator.onLine) {
    await tx('outbox', 'readwrite', (s) => s.add(item));
    changed();
    return 'queued';
  }
  try {
    await post(item);
    return 'sent';
  } catch (e) {
    if (e instanceof HttpFail) throw e;
    await tx('outbox', 'readwrite', (s) => s.add(item));
    changed();
    return 'queued';
  }
}

let flushing = false;
export async function flush() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const it of await all()) {
      try {
        await post(it);
      } catch (e) {
        if (!(e instanceof HttpFail)) break; // still offline: keep order, try later
        failed = [...failed, { meta: it.meta, error: e.message }];
      }
      await remove(it.id!);
      changed();
    }
  } finally {
    flushing = false;
  }
}

export function useOutbox() {
  const [items, setItems] = useState<Item[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const refresh = () => all().then(setItems).catch(() => {});
    const on = () => { setOnline(navigator.onLine); if (navigator.onLine) flush(); };
    listeners.add(refresh);
    refresh();
    flush();
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    const t = setInterval(flush, 30_000);
    return () => { listeners.delete(refresh); window.removeEventListener('online', on); window.removeEventListener('offline', on); clearInterval(t); };
  }, []);
  return { items, online, failed, clearFailed: () => { failed = []; changed(); } };
}

/** Clear on sign-out: nothing patient-identifiable stays on the device. */
export const wipe = () => new Promise<void>((res) => { const r = indexedDB.deleteDatabase('baton-field'); r.onsuccess = r.onerror = r.onblocked = () => res(); });

/** Shrink camera photos before upload: max 1600 px, JPEG. */
export async function compress(file: File, max = 1600): Promise<Blob> {
  const img = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b ?? file), 'image/jpeg', 0.82));
}
