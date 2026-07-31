'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';
import type { UazapiInstanceStatus } from '@/lib/whatsapp/uazapi-api';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

const UAZAPI_STATUS_LABEL_PT: Record<UazapiInstanceStatus, string> = {
  disconnected: 'Desconectado',
  connecting: 'Aguardando conexão',
  connected: 'Conectado',
  hibernated: 'Hibernado',
};

/** Maps a failed fetch to PT-BR copy + whether it means "instance is
 *  gone/invalid" (→ offer recreate) vs. everything else (→ just an
 *  error message, no recreate offered). Shared by every UAZAPI call
 *  in this component so 401/403/409/500/502 are handled uniformly. */
function describeUazapiFetchError(
  status: number,
  data: { error?: string; code?: string } | undefined,
): { message: string; instanceInvalid: boolean } {
  if (data?.code === 'instance_invalid') {
    return {
      message: data.error || 'A instância UAZAPI não foi encontrada ou é inválida.',
      instanceInvalid: true,
    };
  }
  if (status === 401) {
    return { message: 'Sessão expirada. Atualize a página e faça login novamente.', instanceInvalid: false };
  }
  if (status === 403) {
    return {
      message: 'Você não tem permissão para esta ação. Fale com um administrador da conta.',
      instanceInvalid: false,
    };
  }
  if (status === 500) {
    return { message: 'Erro interno do servidor. Tente novamente em instantes.', instanceInvalid: false };
  }
  // 409 (concurrency/incomplete-config) and 502 (UAZAPI unreachable)
  // already carry a human-readable message from the route itself.
  return { message: data?.error || 'Erro desconhecido.', instanceInvalid: false };
}

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const { user, accountId, canEditSettings, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [uazapiStatus, setUazapiStatus] = useState<UazapiInstanceStatus | null>(null);
  const [uazapiQrCode, setUazapiQrCode] = useState<string | null>(null);
  const [uazapiPairCode, setUazapiPairCode] = useState<string | null>(null);
  const [uazapiConnecting, setUazapiConnecting] = useState(false);
  const [uazapiRefreshingStatus, setUazapiRefreshingStatus] = useState(false);
  const [uazapiError, setUazapiError] = useState<string | null>(null);
  const [uazapiInstanceInvalid, setUazapiInstanceInvalid] = useState(false);
  const [creatingUazapiInstance, setCreatingUazapiInstance] = useState(false);
  const [recreatingUazapiInstance, setRecreatingUazapiInstance] = useState(false);
  const uazapiPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uazapiPollErrorCountRef = useRef(0);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  // Guards against re-hydrating the form when the load effect below
  // re-runs for reasons unrelated to actually switching accounts —
  // e.g. Supabase's onAuthStateChange fires a token refresh (new
  // `user` object, profileLoading flips true/false) when the browser
  // tab regains focus. Without this, that churn calls fetchConfig()
  // again and overwrites whatever the user typed but hadn't saved yet.
  const loadedAccountIdRef = useRef<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  // True once /register has succeeded on Meta's side (timestamp set
  // in the row). When false, the saved config is metadata-only and
  // Meta will silently drop every inbound event — that's the
  // multi-number bug that prompted this work.
  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      // Load form values from Supabase (shows what's in DB).
      // Switched from `user_id` (which would only match the row's
      // original author) to `account_id` so every member of the
      // account sees the same saved configuration. UNIQUE(account_id)
      // on the table guarantees the .maybeSingle() return type
      // remains accurate.
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      if (data) {
        setConfig(data);
        setPhoneNumberId(data.phone_number_id || '');
        setWabaId(data.waba_id || '');
        setAccessToken(MASKED_TOKEN);
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
      } else {
        setConfig(null);
        setPhoneNumberId('');
        setWabaId('');
        setAccessToken('');
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
      }
      // Clear any stale probe result when reloading the row.
      setRegistrationProbe(null);

      // Then verify health via the API (decrypts token + pings Meta).
      // Meta-only probe — a UAZAPI row has no access_token to decrypt
      // and would otherwise show a false "token corrupted" banner
      // whose Reset button deletes the whole row (incl. UAZAPI).
      if (data && data.provider === 'meta') {
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
          } else {
            setConnectionStatus('disconnected');
            setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
            setStatusMessage(payload.message || '');
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Failed to load WhatsApp configuration');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  async function handleSave() {
    if (config?.provider === 'uazapi') {
      // Meta-only form; nothing to validate/save while UAZAPI is the
      // active provider. The button is hidden in this state — this
      // guard just keeps the function itself provider-aware too.
      return;
    }
    if (!phoneNumberId.trim()) {
      toast.error('Phone Number ID is required');
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Access Token is required for initial setup');
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Meta and encrypts
      // the access_token server-side with ENCRYPTION_KEY. Skipping this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
        // Optional — only sent when the user filled it in. The server
        // requires it on first save or when changing numbers; for a
        // simple token rotation, leaving it blank skips re-register.
        pin: pin.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config — reuse stored encrypted token by decrypting on the
        // server. But our POST handler requires an access_token to verify
        // with Meta. If the user didn't change the token, we need to signal
        // that. Simplest: require token re-entry if they're updating.
        toast.error('Please re-enter the Access Token to save changes');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        setSaving(false);
        return;
      }

      // The route now returns a structured outcome:
      //   * registered=true   → number is live, events will flow
      //   * registered=false  → credentials saved but /register
      //                         failed; UI shows the specific error
      //                         and a retry path. registration_error
      //                         is human-readable from Meta.
      if (data.registered === false && data.registration_error) {
        toast.error(
          `Saved, but Meta couldn't register the number: ${data.registration_error}`,
          { duration: 12000 },
        );
      } else if (data.registration_skipped) {
        // Credentials saved + verified, but /register was skipped
        // because no PIN was supplied (e.g. a Meta test number).
        // Don't claim the number is "Live" — point at the
        // Registration status banner instead.
        toast.success(
          'Credentials saved and verified. Inbound registration was skipped (no PIN) — see Registration status below.',
          { duration: 10000 },
        );
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Live — ${data.phone_info.verified_name} can now receive events.`
            : 'WhatsApp connected. Events will start flowing within a minute.',
        );
        // Clear the PIN so subsequent saves don't accidentally
        // re-register (which would void the active subscription if
        // the PIN became stale).
        setPin('');
      }

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? `Connected to ${payload.phone_info.verified_name}`
            : 'API connection successful'
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'API connection failed');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success('Number is fully wired — Meta is delivering events.');
      } else {
        toast.error(
          'Number is not fully registered. See the checks below for which step failed.',
          { duration: 8000 },
        );
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error('Could not reach the verification endpoint.');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete the current WhatsApp config so you can re-enter it. Continue?')) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }

      toast.success('Configuration cleared. You can now re-enter your credentials.');
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  // ============================================================
  // UAZAPI — connect existing instance by QR code (ETAPA 7).
  // Reuses the instance already provisioned in ETAPA 6.1; never
  // creates a new one. Only meaningful when config.provider ===
  // 'uazapi'. GET /status is read-only; POST /connect is the only
  // call that starts a real connection attempt, and only fires on
  // an explicit "Gerar QR Code" click, never automatically.
  // ============================================================
  const stopUazapiPolling = useCallback(() => {
    if (uazapiPollIntervalRef.current) {
      clearInterval(uazapiPollIntervalRef.current);
      uazapiPollIntervalRef.current = null;
    }
    uazapiPollErrorCountRef.current = 0;
  }, []);

  const refreshUazapiStatus = useCallback(async (): Promise<UazapiInstanceStatus | 'invalid' | null> => {
    try {
      const res = await fetch('/api/uazapi/status', { method: 'GET' });
      const data = await res.json();
      if (!res.ok) {
        const { message, instanceInvalid } = describeUazapiFetchError(res.status, data);
        setUazapiInstanceInvalid(instanceInvalid);
        setUazapiError(instanceInvalid ? null : message);
        return instanceInvalid ? 'invalid' : null;
      }
      setUazapiInstanceInvalid(false);
      setUazapiStatus(data.status);
      setUazapiError(null);
      // A QR/pairing code is only meaningful while 'connecting' —
      // any other status means it's stale (expired, already used,
      // or the instance moved on) and must not linger on screen.
      if (data.status !== 'connecting') {
        setUazapiQrCode(null);
        setUazapiPairCode(null);
      }
      return data.status as UazapiInstanceStatus;
    } catch (err) {
      console.error('uazapi status refresh failed:', err);
      setUazapiError('Erro de rede ao consultar status.');
      return null;
    }
  }, []);

  const startUazapiPolling = useCallback(() => {
    stopUazapiPolling();
    uazapiPollIntervalRef.current = setInterval(async () => {
      const status = await refreshUazapiStatus();
      if (status === 'invalid') {
        stopUazapiPolling();
        return;
      }
      if (status === null) {
        uazapiPollErrorCountRef.current += 1;
        if (uazapiPollErrorCountRef.current >= 5) {
          stopUazapiPolling();
          setUazapiError(
            'Não foi possível confirmar o status após várias tentativas. Tente atualizar manualmente.',
          );
        }
        return;
      }
      uazapiPollErrorCountRef.current = 0;
      // Stop conditions: connected, disconnected, hibernated — only
      // 'connecting' keeps the poll alive.
      if (status === 'connected' || status === 'disconnected' || status === 'hibernated') {
        stopUazapiPolling();
      }
    }, 3500);
  }, [refreshUazapiStatus, stopUazapiPolling]);

  // Stop condition: provider switched away from 'uazapi' while this
  // component stays mounted (e.g. another admin changed it).
  useEffect(() => {
    if (config?.provider !== 'uazapi') {
      stopUazapiPolling();
    }
  }, [config?.provider, stopUazapiPolling]);

  // Stop condition: component unmounted.
  useEffect(() => {
    return () => stopUazapiPolling();
  }, [stopUazapiPolling]);

  // Read-only auto-refresh the moment a UAZAPI instance is known to
  // exist. GET only — never creates an instance or starts a
  // connection attempt.
  useEffect(() => {
    if (config?.provider === 'uazapi' && uazapiStatus === null) {
      void refreshUazapiStatus();
    }
  }, [config?.provider, uazapiStatus, refreshUazapiStatus]);

  async function handleGenerateUazapiQrCode() {
    if (uazapiConnecting) return;
    setUazapiConnecting(true);
    setUazapiError(null);
    try {
      const res = await fetch('/api/uazapi/connect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        const { message, instanceInvalid } = describeUazapiFetchError(res.status, data);
        setUazapiInstanceInvalid(instanceInvalid);
        setUazapiError(instanceInvalid ? null : message);
        return;
      }
      setUazapiInstanceInvalid(false);
      setUazapiStatus(data.status);
      setUazapiQrCode(data.status === 'connecting' ? data.qrcode ?? null : null);
      setUazapiPairCode(data.status === 'connecting' ? data.paircode ?? null : null);
      if (data.status === 'connecting') {
        startUazapiPolling();
      } else if (data.status === 'connected') {
        stopUazapiPolling();
        toast.success('WhatsApp já está conectado.');
      }
    } catch (err) {
      console.error('uazapi connect failed:', err);
      setUazapiError('Erro de rede ao gerar o QR Code.');
    } finally {
      setUazapiConnecting(false);
    }
  }

  async function handleRefreshUazapiStatusClick() {
    if (uazapiRefreshingStatus) return;
    setUazapiRefreshingStatus(true);
    await refreshUazapiStatus();
    setUazapiRefreshingStatus(false);
  }

  // Estado (a): nenhuma configuração UAZAPI ainda para esta conta.
  // Só cria — nunca apaga nada; se já houver credenciais Meta na
  // mesma linha, a rota já preserva ambas (dormant), sem tocar nelas.
  async function handleCreateUazapiInstance() {
    if (creatingUazapiInstance) return;

    // Só pede confirmação extra quando já existe uma configuração Meta
    // ativa — criar do zero (nenhuma configuração) não precisa disso.
    if (config?.provider === 'meta') {
      const confirmed = confirm(
        'Esta conta está usando a Meta Cloud API. Ao criar a instância UAZAPI, ' +
          'a UAZAPI passará a ser o provedor ativo para novos envios. As ' +
          'credenciais Meta serão preservadas, mas somente um provedor opera ' +
          'por vez. Deseja continuar?',
      );
      if (!confirmed) return;
    }

    setCreatingUazapiInstance(true);
    setUazapiError(null);
    try {
      const res = await fetch('/api/uazapi/instance', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        const { message } = describeUazapiFetchError(res.status, data);
        setUazapiError(message);
        return;
      }
      toast.success(
        'UAZAPI é agora o provedor ativo desta conta. As credenciais Meta ' +
          'continuam salvas como alternativa — não há troca automática entre ' +
          'provedores; para voltar ao Meta, desconecte o UAZAPI explicitamente.',
        { duration: 12000 },
      );
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('uazapi instance creation failed:', err);
      setUazapiError('Erro de rede ao criar a instância.');
    } finally {
      setCreatingUazapiInstance(false);
    }
  }

  // Estado (c): a linha local diz 'uazapi' mas a UAZAPI não reconhece
  // mais essa instância (deletada manualmente no painel, por ex.).
  // DELETE só mexe na linha whatsapp_config desta conta — nunca em
  // contacts/conversations/messages/profiles/accounts — e só então o
  // POST cria uma instância nova. Sequencial, nunca em paralelo, para
  // nunca ter duas instâncias vivas ao mesmo tempo.
  async function handleRecreateUazapiInstance() {
    if (recreatingUazapiInstance) return;
    if (
      !confirm(
        'Isso vai remover a configuração UAZAPI local (inválida) e criar uma instância nova. Contatos, conversas, mensagens, usuários, a conta e eventuais dados Meta preservados NÃO são afetados. Continuar?',
      )
    ) {
      return;
    }
    setRecreatingUazapiInstance(true);
    setUazapiError(null);
    try {
      const delRes = await fetch('/api/uazapi/instance', { method: 'DELETE' });
      const delData = await delRes.json();
      if (!delRes.ok) {
        const { message } = describeUazapiFetchError(delRes.status, delData);
        setUazapiError(message);
        return;
      }
      const createRes = await fetch('/api/uazapi/instance', { method: 'POST' });
      const createData = await createRes.json();
      if (!createRes.ok) {
        const { message } = describeUazapiFetchError(createRes.status, createData);
        setUazapiError(message);
        return;
      }
      setUazapiInstanceInvalid(false);
      setUazapiStatus(null);
      toast.success('Instância UAZAPI recriada.');
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('uazapi instance recreation failed:', err);
      setUazapiError('Erro de rede ao recriar a instância.');
    } finally {
      setRecreatingUazapiInstance(false);
    }
  }

  const canGenerateUazapiQrCode =
    Boolean(user) &&
    canEditSettings &&
    config?.provider === 'uazapi' &&
    !uazapiInstanceInvalid &&
    uazapiStatus !== 'connected';

  const showCreateUazapiInstanceButton =
    Boolean(user) && canEditSettings && config?.provider !== 'uazapi';

  // Meta-only UI (fields, connection/registration status, Save/Test/
  // Reset) only makes sense when there's no config yet (onboarding
  // via Meta) or the account is already on Meta. Hidden — not just
  // disabled — while UAZAPI is active.
  const showMetaSection = !config || config.provider === 'meta';

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t("title")}
          description={t("description")}
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {showMetaSection ? (
          <>
        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  Stored token can&apos;t be decrypted
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('resetting')}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      {t('resetConfig')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status */}
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connectionStatus === 'connected' ? t('credentialsValid') : t('notConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? t('connectedDesc')
              : statusMessage ||
                t('notConnectedDesc')}
          </AlertDescription>
        </Alert>

        {/* Registration Status — the "is it actually live?" check.
            Credentials being valid is necessary but not sufficient;
            without a successful /register call the number won't
            receive inbound events. Surface this dimension separately
            so users don't trust a misleading green banner. */}
        {config && (
          <Alert
            className={
              isRegistered
                ? 'bg-emerald-950/30 border-emerald-700/50'
                : 'bg-amber-950/30 border-amber-700/50'
            }
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle
                  className={
                    'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                  }
                >
                  {isRegistered
                    ? t('registered')
                    : t('notRegistered')}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border bg-transparent text-foreground hover:bg-muted h-7"
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {t('verifyWithMeta')}
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <span
                  dangerouslySetInnerHTML={{
                    __html: t('subscribedSince', {
                      date: config.registered_at
                        ? new Date(config.registered_at).toLocaleString()
                        : t('unknownDate'),
                    }),
                  }}
                />
              ) : lastRegistrationError ? (
                <>
                  {t('lastAttemptFailed')}
                  <span className="text-red-300">
                    &quot;{lastRegistrationError}&quot;
                  </span>
                  . {t('retryHint')}
                </>
              ) : (
                <>{t('noRegistrationHint')}</>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  {t('diagnosticLastRun')}
                  <span className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}>
                    {registrationProbe.live ? t('live') : t('notLive')}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-red-400 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {/* API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('apiCredentialsTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('apiCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('phoneNumberId')}</Label>
              <Input
                placeholder="e.g. 100234567890123"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('wabaId')}</Label>
              <Input
                placeholder="e.g. 100234567890456"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('accessToken')}</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('accessTokenPlaceholder')}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-xs text-muted-foreground">
                  {t('tokenHidden')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookVerifyToken')}</Label>
              <Input
                placeholder={t('webhookVerifyTokenPlaceholder')}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('webhookVerifyTokenHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('twoStepPin')}
                <span className="ml-1 text-muted-foreground">{t('optional')}</span>
              </Label>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder={t('pinPlaceholder')}
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span dangerouslySetInnerHTML={{ __html: t('pinHint') }} />
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Webhook URL */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('webhookTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('webhookDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
          </>
        ) : (
          <Alert className="bg-card border-border">
            <AlertTitle className="text-foreground">
              Meta Cloud API preservada
            </AlertTitle>
            <AlertDescription className="text-muted-foreground text-sm">
              Esta conta está usando UAZAPI como provedor ativo. Eventuais
              credenciais Meta ficam preservadas e ocultas aqui enquanto o
              UAZAPI estiver ativo.
            </AlertDescription>
          </Alert>
        )}

        {/* UAZAPI (ETAPA 7.2) — sempre visível, com 4 ramos internos:
            (a) nenhuma configuração, (b) instância válida desconectada/
            conectando/hibernada, (c) instância local existe mas é
            inválida na UAZAPI, (d) conectada. Nunca cria/reconecta
            automaticamente — só por clique explícito. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">UAZAPI (WhatsApp via QR Code)</CardTitle>
            <CardDescription className="text-muted-foreground">
              Conexão alternativa ao Meta Cloud API — um número oficial da empresa, conectado por QR Code.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {uazapiError && (
              <Alert className="bg-red-950/30 border-red-700/50">
                <AlertTitle className="text-red-200">Erro</AlertTitle>
                <AlertDescription className="text-red-100/80 text-sm">
                  {uazapiError}
                </AlertDescription>
              </Alert>
            )}

            {/* (a) nenhuma configuração UAZAPI ainda */}
            {(!config || config.provider !== 'uazapi') && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Nenhuma instância UAZAPI configurada para esta conta.
                </p>
                {showCreateUazapiInstanceButton ? (
                  <Button
                    onClick={handleCreateUazapiInstance}
                    disabled={creatingUazapiInstance}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                  >
                    {creatingUazapiInstance ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Criando…
                      </>
                    ) : (
                      'Criar instância UAZAPI'
                    )}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Somente administradores podem criar a instância UAZAPI.
                  </p>
                )}
              </div>
            )}

            {/* (c) instância existe localmente mas é inválida na UAZAPI */}
            {config?.provider === 'uazapi' && uazapiInstanceInvalid && (
              <div className="space-y-3">
                <Alert className="bg-amber-950/30 border-amber-700/50">
                  <AlertTitle className="text-amber-200">Instância UAZAPI não encontrada</AlertTitle>
                  <AlertDescription className="text-amber-100/80 text-sm">
                    A configuração local existe, mas o servidor UAZAPI não reconhece mais essa
                    instância (pode ter sido removida manualmente). Contatos, conversas, mensagens e
                    a conta não são afetados por essa situação.
                  </AlertDescription>
                </Alert>
                {canEditSettings ? (
                  <Button
                    variant="outline"
                    onClick={handleRecreateUazapiInstance}
                    disabled={recreatingUazapiInstance}
                    className="border-amber-700/50 text-amber-300 hover:bg-amber-950/30"
                  >
                    {recreatingUazapiInstance ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Recriando…
                      </>
                    ) : (
                      'Recriar instância UAZAPI'
                    )}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Somente administradores podem recriar a instância UAZAPI.
                  </p>
                )}
              </div>
            )}

            {/* (b)/(d) instância válida — status normal ou conectada */}
            {config?.provider === 'uazapi' && !uazapiInstanceInvalid && (
              <>
                <div className="flex items-center gap-2">
                  {uazapiStatus === 'connected' ? (
                    <CheckCircle2 className="size-4 text-emerald-400" />
                  ) : uazapiStatus === 'connecting' ? (
                    <Loader2 className="size-4 animate-spin text-amber-400" />
                  ) : (
                    <XCircle className="size-4 text-muted-foreground" />
                  )}
                  <span className="text-sm text-foreground">
                    Status: {uazapiStatus ? UAZAPI_STATUS_LABEL_PT[uazapiStatus] : 'Desconhecido'}
                  </span>
                </div>

                {uazapiStatus === 'connected' ? (
                  <Alert className="bg-emerald-950/30 border-emerald-700/50">
                    <AlertTitle className="text-emerald-200">WhatsApp conectado</AlertTitle>
                    <AlertDescription className="text-emerald-100/80 text-sm">
                      Esta instância UAZAPI está conectada e pronta para uso.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <>
                    {uazapiQrCode && (
                      <div className="flex flex-col items-center gap-2 rounded border border-border bg-muted p-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={uazapiQrCode}
                          alt="QR Code de conexão do WhatsApp"
                          className="size-56"
                        />
                        <p className="text-xs text-muted-foreground text-center">
                          Abra o WhatsApp no celular do número oficial → Aparelhos conectados → Conectar um aparelho.
                        </p>
                      </div>
                    )}

                    {uazapiPairCode && (
                      <p className="text-sm text-foreground">
                        Código de pareamento:{' '}
                        <span className="font-mono tracking-widest">{uazapiPairCode}</span>
                      </p>
                    )}
                  </>
                )}

                <div className="flex flex-wrap gap-3 items-center">
                  {canGenerateUazapiQrCode && (
                    <Button
                      onClick={handleGenerateUazapiQrCode}
                      disabled={uazapiConnecting}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    >
                      {uazapiConnecting ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Gerando…
                        </>
                      ) : (
                        'Gerar QR Code'
                      )}
                    </Button>
                  )}
                  {!canEditSettings && uazapiStatus !== 'connected' && (
                    <p className="text-xs text-muted-foreground">
                      Somente administradores podem gerar um novo QR Code.
                    </p>
                  )}
                  <Button
                    variant="outline"
                    onClick={handleRefreshUazapiStatusClick}
                    disabled={uazapiRefreshingStatus}
                    className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    {uazapiRefreshingStatus ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Atualizando…
                      </>
                    ) : (
                      'Atualizar status'
                    )}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {showMetaSection && (
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveConfig')
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('testing')}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                {t('testConnection')}
              </>
            )}
          </Button>
          {config && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetConfig')}
                </>
              )}
            </Button>
          )}
        </div>
        )}
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">{t('setupInstructions')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('setupInstructionsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    {t('step1')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li dangerouslySetInnerHTML={{ __html: t('step1_1') }} />
                    <li>{t('step1_2')}</li>
                    <li>{t('step1_3')}</li>
                    <li>{t('step1_4')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    {t('step2')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step2_1')}</li>
                    <li>{t('step2_2')}</li>
                    <li>{t('step2_3')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    {t('step3')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step3_1')}</li>
                    <li>
                      {t.rich('step3_2', {
                        strong: (chunks) => (
                          <strong className="text-foreground">{chunks}</strong>
                        ),
                      })}
                    </li>
                    <li>
                      {t.rich('step3_3', {
                        strong: (chunks) => (
                          <strong className="text-foreground">{chunks}</strong>
                        ),
                      })}
                    </li>
                    <li>
                      {t.rich('step3_4', {
                        strong: (chunks) => (
                          <strong className="text-foreground">{chunks}</strong>
                        ),
                      })}
                    </li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    {t('step4')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step4_1')}</li>
                    <li>{t('step4_2')}</li>
                    <li>
                      {t.rich('step4_3', {
                        strong: (chunks) => (
                          <strong className="text-foreground">{chunks}</strong>
                        ),
                      })}
                    </li>
                    <li>
                      {t.rich('step4_4', {
                        strong: (chunks) => (
                          <strong className="text-foreground">{chunks}</strong>
                        ),
                      })}
                    </li>
                    <li>{t('step4_5')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('metaDocs')}
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
    </section>
  );
}
