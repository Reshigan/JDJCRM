import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api, formValues } from '../api';
import { BatonMark, Button, ErrorText, Field, Input } from '../ui';

type Step = 'password' | 'verify' | 'setup';

export function Login() {
  const [step, setStep] = useState<Step>('password');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ qr: string; secret: string } | null>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const from = (useLocation().state as any)?.from ?? '/';

  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    nav(from, { replace: true });
  };
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (step === 'setup' && !qr) api('/auth/mfa/setup', { body: {} }).then(setQr, setError);
  }, [step, qr]);

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-[#0E1726] p-12 text-white lg:flex lg:flex-col">
        <div className="flex items-center gap-3">
          <BatonMark size={36} />
          <span className="text-lg font-semibold tracking-tight">Baton</span>
        </div>
        <div className="mt-auto max-w-lg">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight">Every handover, owned.</h1>
          <p className="mt-4 text-[15px] leading-relaxed text-white/65">
            Every query and every hospital bleed gets a ticket, a named owner at each stage and a time stamp at each handover, with a clock that tells you before anything goes red.
          </p>
          <div className="mt-10 flex gap-1.5" aria-hidden>
            {['#4ADE80', '#4ADE80', '#4ADE80', '#FBBF24', '#7482FF', '#7482FF'].map((c, i) => (
              <span key={i} className={i === 3 ? 'pulse h-2 flex-1 rounded-full' : 'h-2 flex-1 rounded-full'} style={{ background: c, opacity: i > 3 ? 0.3 : 1 }} />
            ))}
          </div>
          <div className="mt-2 grid grid-cols-6 gap-1.5 text-[11px] text-white/45">
            {['Response', 'Bleed', 'Logistics', 'Receiving', 'Processing', 'Reporting'].map((s) => <span key={s}>{s}</span>)}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden"><BatonMark size={32} /><span className="text-lg font-semibold">Baton</span></div>

          {step === 'password' && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                const v = formValues(e);
                run(async () => {
                  const r = await api('/auth/login', { body: v });
                  if (r.mfa === 'ok') await done();
                  else setStep(r.mfa);
                })();
              }}
            >
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
                <p className="mt-1 text-sm text-muted">Use your network (AD) login or your Baton account.</p>
              </div>
              <Field label="E-mail or username"><Input name="username" autoComplete="username" autoFocus required /></Field>
              <Field label="Password"><Input name="password" type="password" autoComplete="current-password" required /></Field>
              <ErrorText error={error} />
              <Button className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
            </form>
          )}

          {step !== 'password' && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                const v = formValues(e);
                run(async () => { await api('/auth/mfa/verify', { body: v }); await done(); })();
              }}
            >
              <div className="flex items-center gap-2 text-brand"><ShieldCheck size={20} /><span className="text-sm font-medium">Two-factor verification</span></div>
              {step === 'setup' ? (
                <>
                  <h2 className="text-2xl font-semibold tracking-tight">Set up your authenticator</h2>
                  <p className="text-sm text-muted">Your role requires two-factor sign-in. Scan with Microsoft or Google Authenticator, then enter the 6-digit code.</p>
                  {qr && (
                    <div className="card flex flex-col items-center gap-2 p-4">
                      <img src={qr.qr} alt="Authenticator QR code" width={180} height={180} className="rounded bg-white p-1" />
                      <code className="num text-xs break-all text-muted">{qr.secret}</code>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h2 className="text-2xl font-semibold tracking-tight">Enter your code</h2>
                  <p className="text-sm text-muted">Open your authenticator app and enter the 6-digit code for Baton.</p>
                </>
              )}
              <Field label="Code"><Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,8}" autoFocus required className="num text-lg tracking-[0.3em]" /></Field>
              <ErrorText error={error} />
              <Button className="w-full" disabled={busy}>Verify</Button>
              <button type="button" className="w-full text-center text-sm text-muted hover:text-text" onClick={() => { setStep('password'); setQr(null); }}>Back</button>
            </form>
          )}
          <p className="mt-10 text-center text-xs text-muted">Access is logged and audited. POPIA-protected patient information.</p>
        </div>
      </div>
    </div>
  );
}
