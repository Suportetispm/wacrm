'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircle, KeyRound, Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { MIN_PASSWORD, submitNewPassword, type ResetPasswordError } from '@/lib/auth/reset-password';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// How long the success message stays up before we hand off to /login
// with a full page reload — matches the "hard navigation, not
// router.push" pattern the login/logout flows already use elsewhere
// in this app, so the browser always carries a fresh, non-recovery
// request into the next page.
const SUCCESS_REDIRECT_DELAY_MS = 1500;

function errorMessageKey(error: ResetPasswordError): 'passwordTooShort' | 'passwordMismatch' | 'updateFailed' {
  if (error === 'too_short') return 'passwordTooShort';
  if (error === 'mismatch') return 'passwordMismatch';
  return 'updateFailed';
}

export function ResetPasswordForm() {
  const t = useTranslations('ResetPasswordPage');
  const supabase = createClient();

  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionValid, setSessionValid] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // The server-side cookie gate (reset-password/page.tsx) only
    // proves the visitor recently came through the recovery
    // callback — it doesn't prove Supabase still has a live session
    // (link already used, expired, or the exchange silently failed).
    // Confirm here before letting anyone touch the form.
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setSessionValid(Boolean(data.user));
      setCheckingSession(false);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const result = await submitNewPassword(supabase.auth, password, confirm, MIN_PASSWORD);

    setSaving(false);
    if (!result.ok) {
      setError(t(errorMessageKey(result.error), { min: MIN_PASSWORD }));
      return;
    }

    setPassword('');
    setConfirm('');
    setSuccess(true);
    window.setTimeout(() => {
      window.location.href = '/login';
    }, SUCCESS_REDIRECT_DELAY_MS);
  };

  if (checkingSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>{t('checkingSession')}</span>
        </div>
      </div>
    );
  }

  if (!sessionValid) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <CardTitle className="text-xl text-foreground">{t('sessionExpiredTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('sessionExpiredDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/forgot-password">
              <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                {t('requestNewLink')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">{t('successTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">{t('successDesc')}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">{t('title')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {error && (
              <div
                role="alert"
                className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
              >
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="new-password" className="text-muted-foreground">
                {t('newPasswordLabel')}
              </Label>
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                required
                disabled={saving}
                className="border-border bg-muted text-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-password" className="text-muted-foreground">
                {t('confirmPasswordLabel')}
              </Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                required
                disabled={saving}
                className="border-border bg-muted text-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={saving}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('updating')}
                </>
              ) : (
                t('submitButton')
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
