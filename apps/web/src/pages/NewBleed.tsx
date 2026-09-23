import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus, Trash2, UserRound } from 'lucide-react';
import { formatMinutes, INTERVALS } from '@baton/core';
import { api, useLookups } from '../api';
import { Button, Card, ErrorText, Field, Input, Select, Textarea } from '../ui';

type Patient = { patient_name: string; folder_no: string; ward: string; bed: string };
const blank: Patient = { patient_name: '', folder_no: '', ward: '', bed: '' };

export function NewBleed() {
  const { data: lk } = useLookups();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [hospitalId, setHospitalId] = useState('');
  const [nurseId, setNurseId] = useState('');
  const [patients, setPatients] = useState<Patient[]>([{ ...blank }]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const hospitals = lk?.organisations.filter((o) => o.kind === 'hospital') ?? [];
  const nurseDept = lk?.departments.find((d) => d.code === 'NUR')?.id;
  const nurses = lk?.users.filter((u) => u.department_id === nurseDept) ?? [];
  const hospital = hospitals.find((h) => String(h.id) === hospitalId);
  const allocated = nurses.find((n) => n.id === (nurseId || hospital?.nurse_id));
  const setP = (i: number, k: keyof Patient, v: string) => setPatients(patients.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api('/bleed-requests', {
        body: { hospital_id: +hospitalId, nurse_id: nurseId || null, requested_by: fd.get('requested_by'), contact_phone: fd.get('contact_phone'), notes: fd.get('notes'), patients },
      });
      qc.invalidateQueries({ queryKey: ['bleeds'] });
      nav(`/bleeds/${r.bleed_ids[0]}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New bleed request</h1>
          <p className="mt-0.5 text-sm text-muted">One call can request several patients. Each patient gets their own ticket and clock; the response clock starts now.</p>
        </div>
        <Card title="The call">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Hospital" required className="sm:col-span-2">
              <Select value={hospitalId} onChange={(e) => { setHospitalId(e.target.value); setNurseId(''); }} required>
                <option value="">Choose the hospital</option>
                {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </Select>
            </Field>
            <Field label="Requested by" required hint="Name and ward of the caller"><Input name="requested_by" required placeholder="Sister Naidoo, Ward 4B" /></Field>
            <Field label="Call-back number"><Input name="contact_phone" type="tel" /></Field>
            <Field label="Notes for the nurse" className="sm:col-span-2"><Textarea name="notes" rows={2} placeholder="Urgent, fasting, isolation, etc." /></Field>
          </div>
        </Card>
        <Card title={`Patients (${patients.length})`} action={<Button type="button" size="sm" variant="outline" onClick={() => setPatients([...patients, { ...blank }])}><Plus size={14} />Add patient</Button>}>
          <div className="space-y-3">
            {patients.map((p, i) => (
              <div key={i} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-[1.6fr_1fr_0.8fr_0.6fr_auto] sm:items-end">
                <Field label={`Patient ${i + 1}`} required><Input value={p.patient_name} onChange={(e) => setP(i, 'patient_name', e.target.value)} required /></Field>
                <Field label="Folder no."><Input value={p.folder_no} onChange={(e) => setP(i, 'folder_no', e.target.value)} className="num" /></Field>
                <Field label="Ward"><Input value={p.ward} onChange={(e) => setP(i, 'ward', e.target.value)} /></Field>
                <Field label="Bed"><Input value={p.bed} onChange={(e) => setP(i, 'bed', e.target.value)} /></Field>
                <Button type="button" variant="ghost" aria-label="Remove patient" disabled={patients.length === 1} onClick={() => setPatients(patients.filter((_, j) => j !== i))}><Trash2 size={15} /></Button>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Card title="Nurse">
          {hospital ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <UserRound size={16} className="text-brand" />
                {allocated ? <span><b>{allocated.name}</b> will be notified</span> : <span className="text-bad">No nurse allocated to this hospital — choose one</span>}
              </div>
              <Select value={nurseId} onChange={(e) => setNurseId(e.target.value)}>
                <option value="">{hospital.nurse_id ? 'Allocated nurse' : 'Choose a nurse'}</option>
                {nurses.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
              </Select>
            </div>
          ) : <p className="text-sm text-muted">Choose a hospital to see its allocated nurse.</p>}
        </Card>
        <Card title="Time limits">
          <ul className="space-y-1.5 text-sm">
            {INTERVALS.map((iv, i) => (
              <li key={iv.key} className="flex justify-between"><span className="text-muted">{i + 1}. {iv.label}</span><span className="num">{formatMinutes(lk?.bleed_limits?.[i] ?? 0)}</span></li>
            ))}
          </ul>
        </Card>
        <ErrorText error={error} />
        <Button className="h-11 w-full" disabled={busy || !hospitalId}>{busy ? 'Sending…' : <>Log and dispatch <ArrowRight size={16} /></>}</Button>
      </aside>
    </form>
  );
}
