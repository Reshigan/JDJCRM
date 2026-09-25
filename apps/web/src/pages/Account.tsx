import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { ROLES } from '@baton/core';
import { api, formValues, useLookups, useMe } from '../api';
import { Badge, Button, Card, ErrorText, Field, Input } from '../ui';

export function Account() {
  const { data: me } = useMe();
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const [qr, setQr] = useState<{ qr: string; secret: string } | null>(null);
  const [msg, setMsg] = useState('');
  const pw = useMutation({ mutationFn: (b: object) => api('/auth/password', { body: b }), onSuccess: () => setMsg('Password changed. Other sessions were signed out.') });
  const setup = useMutation({ mutationFn: () => api('/auth/mfa/setup', { body: {} }), onSuccess: setQr });
  const verify = useMutation({ mutationFn: (code: string) => api('/auth/mfa/verify', { body: { code } }), onSuccess: () => { setQr(null); qc.invalidateQueries({ queryKey: ['me'] }); } });
  if (!me) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
      <Card title="Profile">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted">Name</dt><dd>{me.name}</dd></div>
          <div><dt className="text-xs text-muted">E-mail</dt><dd>{me.email}</dd></div>
          <div><dt className="text-xs text-muted">Role</dt><dd>{ROLES[me.role]}</dd></div>
          <div><dt className="text-xs text-muted">Department</dt><dd>{lk?.departments.find((d) => d.id === me.department_id)?.name ?? '—'}</dd></div>
        </dl>
      </Card>

      <Card title="Two-factor sign-in" action={me.mfa_enabled ? <Badge tone="green"><ShieldCheck size={13} />On</Badge> : <Badge>Off</Badge>}>
        {me.mfa_enabled ? (
          <p className="text-sm text-muted">Your account is protected by an authenticator app. Ask an administrator to reset it if you lose your phone.</p>
        ) : qr ? (
          <form className="space-y-3" onSubmit={(e) => verify.mutate(formValues(e).code)}>
            <img src={qr.qr} alt="Authenticator QR code" width={180} height={180} className="rounded bg-white p-1" />
            <code className="num block text-xs break-all text-muted">{qr.secret}</code>
            <Field label="6-digit code"><Input name="code" inputMode="numeric" required className="num" /></Field>
            <ErrorText error={verify.error} />
            <Button>Turn on</Button>
          </form>
        ) : (
          <Button variant="outline" onClick={() => setup.mutate()}>Set up authenticator</Button>
        )}
      </Card>

      <Card title="Password">
        <form className="space-y-3" onSubmit={(e) => { const v = formValues(e); pw.mutate(v); e.currentTarget.reset(); }}>
          <Field label="Current password"><Input name="current" type="password" required autoComplete="current-password" /></Field>
          <Field label="New password" hint="At least 10 characters."><Input name="next" type="password" minLength={10} required autoComplete="new-password" /></Field>
          <ErrorText error={pw.error} />
          {msg && <p className="text-sm text-ok">{msg}</p>}
          <Button>Change password</Button>
        </form>
      </Card>
    </div>
  );
}
