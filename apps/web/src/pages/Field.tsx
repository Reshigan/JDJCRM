// Baton Field — the nurse's mobile PWA (brief §6.3–6.4). Big targets, one action per screen, works offline.
import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, Check, ChevronRight, CloudOff, LogOut, MapPin, MapPinOff, Minus, Navigation, Phone, Plus, RefreshCw, TriangleAlert } from 'lucide-react';
import { BLEED_STATES, distanceM, formatMinutes, OUTCOMES, PHOTO_SHARPNESS_MIN, TUBE_TYPES, type BleedState, type Outcome } from '@baton/core';
import { readBarcode, sharpness } from '../quality';
import { api, useMe } from '../api';
import { compress, kvGet, kvSet, send, useOutbox, wipe } from '../offline';
import { useLiveEvents } from '../live';
import { BatonBar, BatonMark, Button, cx, ErrorText, Field, FlagPill, Input, RequisitionCheck, Select, Textarea } from '../ui';

type Pos = { lat: number; lng: number; accuracy: number; mock?: boolean };

/** In the Android app (Capacitor shell) positions come from the native plugin, which also reports mock-location apps. */
const native = () => (window as any).Capacitor?.isNativePlatform?.() && (window as any).Capacitor?.Plugins?.MockLocation;

function useGeo() {
  const [pos, setPos] = useState<Pos | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const plugin = native();
    if (plugin) {
      let live = true;
      const poll = () => plugin.getPosition().then((p: Pos) => { if (live) { setPos(p); setError(null); } }, (e: any) => live && setError(e?.message ?? 'Waiting for a GPS fix…'));
      poll();
      const t = setInterval(poll, 4000);
      return () => { live = false; clearInterval(t); };
    }
    if (!('geolocation' in navigator)) return setError('This device has no location service');
    const id = navigator.geolocation.watchPosition(
      (p) => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); setError(null); },
      (e) => setError(e.code === 1 ? 'Location permission is off — allow it in your browser settings' : 'Waiting for a GPS fix…'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  return { pos, error };
}

/** Server data, cached on the device for dead zones; overlaid with actions still in the outbox. */
function useField() {
  const { items } = useOutbox();
  const q = useQuery({
    queryKey: ['field'],
    queryFn: async () => {
      try {
        const d = await api<any[]>('/field');
        await kvSet('field', d).catch(() => {});
        return { data: d, cached: false };
      } catch (e: any) {
        if (e?.status) throw e;
        const d = await kvGet<any[]>('field');
        if (!d) throw e;
        return { data: d, cached: true };
      }
    },
    refetchInterval: 60_000,
    networkMode: 'always',
  });
  const arrived = new Set(items.flatMap((i) => (i.meta.kind === 'arrive' ? [i.meta.request_id] : [])));
  const done = new Map<string, BleedState>();
  for (const i of items) {
    if (i.meta.kind === 'capture') done.set(i.meta.bleed_id, i.meta.outcome === 'successful' ? 'in_transit' : 'unsuccessful');
    if (i.meta.kind === 'file') i.meta.bleed_ids.forEach((b) => done.set(b, 'filed'));
  }
  const data = q.data?.data.map((r) => ({
    ...r,
    arrived: r.arrived || arrived.has(r.id),
    pendingArrival: arrived.has(r.id),
    bleeds: r.bleeds.map((b: any) => (done.has(b.id) ? { ...b, state: done.get(b.id), pendingSync: true } : arrived.has(r.id) && b.state === 'awaiting_arrival' ? { ...b, state: 'on_site', pendingSync: true } : b)),
  }));
  return { ...q, data, cached: q.data?.cached };
}

export function FieldShell() {
  const { data: me, isLoading, error } = useMe();
  const { items, online, failed, clearFailed } = useOutbox();
  useLiveEvents(!!me && online);
  const nav = useNavigate();
  const qc = useQueryClient();
  if (isLoading) return <div className="grid h-dvh place-items-center"><BatonMark size={40} className="pulse" /></div>;
  if ((error as any)?.status === 401 || (!isLoading && !me)) return <Navigate to="/login" replace state={{ from: '/field' }} />;
  const logout = async () => {
    if (items.length && !confirm(`${items.length} action(s) have not synced yet and will be lost. Sign out anyway?`)) return;
    await api('/auth/logout', { body: {} }).catch(() => {});
    await wipe();
    qc.clear();
    nav('/login');
  };
  return (
    <div className="min-h-dvh bg-bg pb-10">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-4 backdrop-blur">
        <Link to="/field" className="flex items-center gap-2"><BatonMark size={26} /><span className="font-semibold">Baton Field</span></Link>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {!online && <span className="flex items-center gap-1 rounded-full bg-warn-soft px-2 py-1 font-medium text-warn"><CloudOff size={13} />Offline</span>}
          {items.length > 0 && <span className="flex items-center gap-1 rounded-full bg-brand-soft px-2 py-1 font-medium text-brand"><RefreshCw size={13} />{items.length} to sync</span>}
          <Button variant="ghost" size="sm" onClick={logout} aria-label="Sign out"><LogOut size={18} /></Button>
        </div>
      </header>
      {failed.length > 0 && (
        <div className="mx-auto mt-3 max-w-lg px-4">
          <div className="rounded-lg bg-bad-soft p-3 text-sm text-bad">
            {failed.map((f, i) => <p key={i}>A synced action was rejected: {f.error}</p>)}
            <button className="mt-1 underline" onClick={clearFailed}>Dismiss</button>
          </div>
        </div>
      )}
      <main className="mx-auto max-w-lg px-4 pt-4"><Outlet /></main>
    </div>
  );
}

export function FieldHome() {
  const { data: me } = useMe();
  const { data, isLoading, error, cached } = useField();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Hello, {me?.name.split(' ').slice(-2, -1)[0] ?? me?.name}</h1>
        <p className="text-sm text-muted">{data?.length ? `${data.length} hospital${data.length > 1 ? 's' : ''} on your run.` : 'Your run is clear.'}{cached && ' Showing the last saved list.'}</p>
      </div>
      <ErrorText error={error} />
      {isLoading && <div className="h-28 animate-pulse rounded-xl bg-surface-2" />}
      {data?.map((r) => {
        const worst = r.bleeds.some((b: any) => b.flag === 'red') ? 'red' : r.bleeds.some((b: any) => b.flag === 'amber') ? 'amber' : 'green';
        const reports = r.bleeds.filter((b: any) => b.state === 'reporting').length;
        return (
          <Link key={r.id} to={`/field/r/${r.id}`} className={cx('card block p-4 active:scale-[0.99]', worst === 'red' && 'border-bad/50')}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-lg font-semibold">{r.hospital}</div>
                <div className="text-sm text-muted">{r.requested_by}</div>
              </div>
              <FlagPill flag={worst as any} />
            </div>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span>{reports ? `${reports} report${reports > 1 ? 's' : ''} to file` : !r.arrived ? `${r.bleeds.length} patient${r.bleeds.length > 1 ? 's' : ''} · go to hospital` : `${r.bleeds.filter((b: any) => b.state === 'on_site').length} to bleed`}</span>
              <ChevronRight size={18} className="text-muted" />
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function GeoGate({ hospital, lat, lng, radius, label, busy, onConfirm, breachNeeded }: {
  hospital: string; lat: number | null; lng: number | null; radius: number; label: string; busy: boolean; breachNeeded: boolean;
  onConfirm: (p: { pos: Pos | null; override_reason?: string; breach_reason?: string }) => void;
}) {
  const { pos, error } = useGeo();
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [breach, setBreach] = useState('');
  const d = pos && lat != null && lng != null ? distanceM({ lat, lng }, pos) : null;
  const inside = d != null && d <= radius && !pos?.mock;
  const ready = !pos?.mock && (!breachNeeded || breach.trim()) && (inside || (override && reason.trim()));
  return (
    <div className="card space-y-4 p-4">
      <div className={cx('flex items-center gap-3 rounded-lg p-3', inside ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-muted')}>
        {inside ? <MapPin size={22} /> : <Navigation size={22} className={cx(!pos && 'pulse')} />}
        <div className="text-sm">
          {inside ? <b>You are at {hospital}</b> : d != null ? <><b className="text-text">{d > 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`}</b> from {hospital} · geofence {radius} m</> : error ?? 'Finding your location…'}
          {pos && <div className="num text-xs opacity-80">GPS ±{Math.round(pos.accuracy)} m</div>}
        </div>
      </div>
      {pos?.mock && <p className="rounded-lg bg-bad-soft p-3 text-sm font-medium text-bad">A fake-GPS (mock location) app is active on this phone. Turn it off in Developer options to confirm your location.</p>}
      {breachNeeded && (
        <Field label="Breach reason" required hint="This stage has passed its time limit."><Input value={breach} onChange={(e) => setBreach(e.target.value)} /></Field>
      )}
      {override && (
        <Field label="Why can't your location be confirmed?" required hint="This is flagged for Client Services review.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Large campus, GPS drift in basement…" />
        </Field>
      )}
      <Button className="h-14 w-full text-base" disabled={!ready || busy} onClick={() => onConfirm({ pos, override_reason: inside ? undefined : reason, breach_reason: breach || undefined })}>
        {inside ? <MapPin size={18} /> : override ? <MapPinOff size={18} /> : <MapPin size={18} />}{label}
      </Button>
      {!inside && !override && <button className="w-full text-center text-sm text-muted underline" onClick={() => setOverride(true)}>I'm on site but outside the geofence</button>}
    </div>
  );
}

function Capture({ b, onDone }: { b: any; onDone: (msg: string) => void }) {
  const [outcome, setOutcome] = useState<Outcome>('successful');
  const [photos, setPhotos] = useState<Record<string, { blob: Blob; url: string; sharp: number }>>({});
  const [scanned, setScanned] = useState(false);
  const [f, setF] = useState({ patient_name: b.patient_name ?? '', folder_no: b.folder_no ?? '', ward: b.ward ?? '', bed: b.bed ?? '', requisition_no: '', outcome_reason: '', breach_reason: '' });
  const [tubes, setTubes] = useState<{ type: string; count: number }[]>([{ type: TUBE_TYPES[0], count: 1 }]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ok = outcome === 'successful';
  const breachNeeded = ok && b.current?.key === 'bleed' && b.current.flag === 'red';
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const snap = (kind: string) => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const blob = await compress(file).catch(() => file);
    const sharp = await sharpness(blob).catch(() => 999);
    setPhotos((p) => ({ ...p, [kind]: { blob, url: URL.createObjectURL(blob), sharp } }));
    if (kind === 'requisition') {
      const code = await readBarcode(file);
      if (code) { setF((x) => (x.requisition_no ? x : { ...x, requisition_no: code })); setScanned(true); }
    }
    e.target.value = ''; // allow retaking the same slot
  };
  const complete = ok
    ? photos.requisition && photos.sticker && f.patient_name && f.folder_no && f.ward && f.bed && tubes.length && (!breachNeeded || f.breach_reason)
    : !!f.outcome_reason.trim();

  const submit = async () => {
    setBusy(true);
    setError(null);
    const form: [string, string | Blob][] = [['outcome', outcome], ['device_time', new Date().toISOString()]];
    if (ok) {
      for (const k of ['patient_name', 'folder_no', 'ward', 'bed', 'requisition_no', 'breach_reason'] as const) if (f[k]) form.push([k, f[k]]);
      form.push(['tubes', JSON.stringify(tubes)], ['requisition', photos.requisition.blob], ['sticker', photos.sticker.blob],
        ['requisition_sharpness', String(Math.round(photos.requisition.sharp))], ['sticker_sharpness', String(Math.round(photos.sticker.sharp))]);
    } else form.push(['outcome_reason', f.outcome_reason]);
    try {
      const r = await send({ url: `/api/bleeds/${b.id}/capture`, form, meta: { kind: 'capture', bleed_id: b.id, outcome } });
      onDone(r === 'queued' ? 'Saved on this phone — it will sync when you have signal.' : ok ? 'Bleed captured. Logistics clock started.' : 'Recorded. Client Services will close the ticket.');
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="mb-2 text-sm font-semibold">Outcome</div>
        <div className="grid grid-cols-1 gap-1.5">
          {(Object.keys(OUTCOMES) as Outcome[]).map((k) => (
            <button key={k} type="button" onClick={() => setOutcome(k)} className={cx('flex h-11 items-center gap-2 rounded-lg border px-3 text-left text-sm', outcome === k ? (k === 'successful' ? 'border-ok bg-ok-soft font-medium text-ok' : 'border-warn bg-warn-soft font-medium text-warn') : 'border-line')}>
              {outcome === k && <Check size={16} />}{OUTCOMES[k]}
            </button>
          ))}
        </div>
      </div>

      {ok ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            {([['requisition', 'Requisition number'], ['sticker', 'Hospital sticker']] as const).map(([k, l]) => (
              <label key={k} className={cx('card flex aspect-[3/4] cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden p-2 text-center text-sm', !photos[k] && 'border-dashed')}>
                {photos[k] ? <img src={photos[k].url} alt={l} className="h-full w-full rounded object-cover" /> : <><Camera size={28} className="text-brand" /><span className="font-medium">{l}</span><span className="text-xs text-muted">Tap to photograph</span></>}
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={snap(k)} />
              </label>
            ))}
          </div>
          {Object.entries(photos).filter(([, p]) => p.sharp < PHOTO_SHARPNESS_MIN).map(([k]) => (
            <p key={k} role="alert" className="flex items-start gap-2 rounded-lg bg-warn-soft p-2.5 text-sm text-warn">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" />The {k === 'sticker' ? 'hospital sticker' : 'requisition'} photo looks blurry. Hold steady and tap it to retake so it can be read.
            </p>
          ))}
          {(photos.requisition || photos.sticker) && <p className="text-center text-xs text-muted">Check each photo is sharp and readable. Tap to retake.</p>}
          <div className="card grid grid-cols-2 gap-3 p-4">
            <Field label="Patient name" required className="col-span-2"><Input value={f.patient_name} onChange={set('patient_name')} /></Field>
            <Field label="Hospital / folder no." required className="col-span-2"><Input value={f.folder_no} onChange={set('folder_no')} className="num" /></Field>
            <Field label="Ward" required><Input value={f.ward} onChange={set('ward')} /></Field>
            <Field label="Bed" required><Input value={f.bed} onChange={set('bed')} /></Field>
            <Field label="Requisition no." className="col-span-2" hint={scanned ? 'Read from the barcode on the photo — check it matches.' : undefined}><Input value={f.requisition_no} onChange={set('requisition_no')} className="num" inputMode="text" />{f.requisition_no && <RequisitionCheck no={f.requisition_no} patient={f.patient_name} />}</Field>
          </div>
          <div className="card space-y-2 p-4">
            <div className="text-sm font-semibold">Tubes drawn</div>
            {tubes.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select aria-label={`Tube ${i + 1} type`} value={t.type} onChange={(e) => setTubes(tubes.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} className="flex-1">
                  {TUBE_TYPES.map((x) => <option key={x}>{x}</option>)}
                </Select>
                <Button type="button" variant="outline" aria-label="Fewer" onClick={() => setTubes(t.count > 1 ? tubes.map((x, j) => (j === i ? { ...x, count: x.count - 1 } : x)) : tubes.filter((_, j) => j !== i))}><Minus size={16} /></Button>
                <span className="num w-6 text-center text-lg">{t.count}</span>
                <Button type="button" variant="outline" aria-label="More" onClick={() => setTubes(tubes.map((x, j) => (j === i ? { ...x, count: Math.min(20, x.count + 1) } : x)))}><Plus size={16} /></Button>
              </div>
            ))}
            <button type="button" className="text-sm text-brand" onClick={() => setTubes([...tubes, { type: TUBE_TYPES[1], count: 1 }])}>+ Add tube type</button>
          </div>
          {breachNeeded && <div className="card p-4"><Field label="Breach reason" required hint="The bleed interval has passed its limit."><Input value={f.breach_reason} onChange={set('breach_reason')} /></Field></div>}
        </>
      ) : (
        <div className="card p-4"><Field label="What happened?" required hint="The ticket ends with this reason."><Textarea value={f.outcome_reason} onChange={set('outcome_reason')} rows={3} /></Field></div>
      )}
      <ErrorText error={error} />
      <Button className="h-14 w-full text-base" disabled={!complete || busy} onClick={submit}>{ok ? 'Complete bleed' : 'Record outcome'}</Button>
    </div>
  );
}

export function FieldRequest() {
  const { id } = useParams() as { id: string };
  const { data, isLoading } = useField();
  const qc = useQueryClient();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [toFile, setToFile] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const r = data?.find((x) => x.id === id);
  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-surface-2" />;
  // The last capture or filing removes the request from the run: keep the confirmation on screen.
  if (!r)
    return (
      <div className="space-y-3">
        {msg ? <p className="flex items-center gap-2 rounded-lg bg-ok-soft p-3 text-sm text-ok"><Check size={16} />{msg}</p> : <p className="text-sm text-muted">This request is complete or no longer allocated to you.</p>}
        <Link to="/field" className="inline-flex h-12 w-full items-center justify-center rounded-lg bg-brand text-sm font-medium text-brand-ink">Back to my run</Link>
      </div>
    );

  const done = (m: string) => { setMsg(m); setCapturing(null); setToFile([]); setBusy(false); qc.invalidateQueries({ queryKey: ['field'] }); };
  const geoSend = async (url: string, body: object, meta: any, okMsg: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await send({ url, json: { ...body, device_time: new Date().toISOString() }, meta });
      done(res === 'queued' ? 'Saved on this phone — it will sync when you have signal.' : okMsg);
    } catch (e) { setError(e); setBusy(false); }
  };
  const geo = (p: { pos: Pos | null; override_reason?: string; breach_reason?: string }) => ({
    lat: p.pos?.lat ?? 0, lng: p.pos?.lng ?? 0, accuracy: p.pos?.accuracy ?? 100_000, mock: p.pos?.mock, override_reason: p.override_reason, breach_reason: p.breach_reason,
  });
  const cap = r.bleeds.find((b: any) => b.id === capturing);
  const reporting = r.bleeds.filter((b: any) => b.state === 'reporting');

  if (cap)
    return (
      <div className="space-y-4">
        <button onClick={() => setCapturing(null)} className="flex items-center gap-1 text-sm text-muted"><ArrowLeft size={15} />{r.hospital}</button>
        <div><div className="num text-xs text-muted">{cap.number}</div><h1 className="text-xl font-semibold">{cap.patient_name}</h1></div>
        <Capture b={cap} onDone={done} />
      </div>
    );

  return (
    <div className="space-y-4">
      <Link to="/field" className="flex items-center gap-1 text-sm text-muted"><ArrowLeft size={15} />My run</Link>
      <div>
        <h1 className="text-xl font-semibold">{r.hospital}</h1>
        <p className="text-sm text-muted">{r.requested_by} · <span className="num">{r.number}</span></p>
        {r.notes && <p className="mt-2 flex gap-2 rounded-lg bg-warn-soft p-2.5 text-sm text-warn"><TriangleAlert size={16} className="mt-0.5 shrink-0" />{r.notes}</p>}
        {r.contact_phone && <a href={`tel:${r.contact_phone}`} className="mt-2 inline-flex items-center gap-1.5 text-sm text-brand"><Phone size={15} />{r.contact_phone}</a>}
      </div>
      {msg && <p className="rounded-lg bg-ok-soft p-3 text-sm text-ok">{msg}</p>}
      <ErrorText error={error} />

      {!r.arrived && (
        <GeoGate
          hospital={r.hospital} lat={r.hospital_lat} lng={r.hospital_lng} radius={r.radius_m} busy={busy} label="I've arrived"
          breachNeeded={r.bleeds.some((b: any) => b.current?.key === 'response' && b.current.flag === 'red')}
          onConfirm={(p) => geoSend(`/api/bleed-requests/${r.id}/arrive`, geo(p), { kind: 'arrive', request_id: r.id }, 'Arrival confirmed. Bleed clock started.')}
        />
      )}

      <div className="space-y-2">
        {r.bleeds.map((b: any) => (
          <div key={b.id} className="card p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{b.patient_name}</div>
                <div className="text-xs text-muted">{[b.ward && `Ward ${b.ward}`, b.bed && `Bed ${b.bed}`].filter(Boolean).join(' · ')} · <span className="num">{b.number}</span></div>
              </div>
              {b.pendingSync ? <span className="flex items-center gap-1 text-xs text-brand"><RefreshCw size={12} />syncing</span> : <FlagPill flag={b.flag} compact />}
            </div>
            <BatonBar intervals={b.intervals} className="mt-3" />
            <div className="mt-1.5 flex justify-between text-xs text-muted">
              <span>{BLEED_STATES[b.state as BleedState]}</span>
              {b.current && !b.pendingSync && <span className="num">{b.current.label} {formatMinutes(b.current.used)} / {formatMinutes(b.current.limit)}</span>}
            </div>
            {b.state === 'on_site' && !b.pendingSync && <Button className="mt-3 h-12 w-full" onClick={() => { setMsg(''); setCapturing(b.id); }}><Camera size={18} />Capture bleed</Button>}
            {b.state === 'reporting' && (
              <label className="mt-3 flex h-12 items-center gap-3 rounded-lg border border-line px-3 text-sm">
                <input type="checkbox" className="h-5 w-5 accent-[var(--brand)]" checked={toFile.includes(b.id)} onChange={(e) => setToFile(e.target.checked ? [...toFile, b.id] : toFile.filter((x) => x !== b.id))} />
                Report is in the patient folder
              </label>
            )}
          </div>
        ))}
      </div>

      {reporting.length > 0 && toFile.length > 0 && (
        <GeoGate
          hospital={r.hospital} lat={r.hospital_lat} lng={r.hospital_lng} radius={r.radius_m} busy={busy}
          label={`Confirm ${toFile.length} report${toFile.length > 1 ? 's' : ''} filed`}
          breachNeeded={reporting.some((b: any) => toFile.includes(b.id) && b.current?.flag === 'red')}
          onConfirm={(p) => geoSend('/api/bleeds/file', { ...geo(p), bleed_ids: toFile }, { kind: 'file', bleed_ids: toFile }, 'Reports filed. Turnaround complete.')}
        />
      )}
    </div>
  );
}
