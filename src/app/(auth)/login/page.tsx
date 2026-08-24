"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SuperMassaLogo, BrandLockup } from "@/components/brand/logo";
import { Eye, EyeOff } from "lucide-react";

// `useSearchParams` opts the component out of static prerendering
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (background, card frame) while the form hydrates with the query
// string on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("LoginPage");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // Full-page navigation (not router.push) so the browser issues a
    // fresh top-level request that carries the just-written Supabase
    // auth cookies to the middleware gating /dashboard. A soft
    // client-side navigation can reach the protected route before the
    // server observes the new session, so the middleware bounces it
    // back to /login — which looks like the page "just refreshing"
    // instead of signing in (issue #365). Mirrors the deliberate full
    // reload the invite-accept flow already uses in join/[token].
    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";
    window.location.href = destination;
  };

  return (
    <div className="flex min-h-screen">
      {/* Left — formulário. Fundo claro fixo, independente do modo
          claro/escuro salvo do usuário: esta tela usa a identidade
          visual da marca, não o tema do painel interno. */}
      <div className="flex w-full flex-col justify-center bg-white px-6 py-12 sm:px-12 lg:w-1/2 lg:px-20">
        <div className="mx-auto w-full max-w-sm">
          <BrandLockup
            className="mt-3 mb-10"
            markSize={44}
            textClassName="text-base"
            subtitleClassName="text-sm"
            subtitle={t("brandSubtitle")}
          />

          <h1 className="text-2xl font-semibold text-neutral-900">
            {inviteToken ? t("titleAccept") : t("titleWelcome")}
          </h1>
          <p className="mt-1.5 text-sm text-neutral-500">
            {inviteToken ? t("descAccept") : t("descWelcome")}
          </p>

          <form onSubmit={handleLogin} className="mt-8 flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-neutral-700">
                {t("emailLabel")}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-neutral-200 bg-white text-neutral-900 placeholder:text-neutral-400 focus-visible:border-[#EE0000] focus-visible:ring-[#EE0000]/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-neutral-700">
                  {t("passwordLabel")}
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-[#EE0000] hover:text-[#AA0000]"
                >
                  {t("forgotPassword")}
                </Link>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder={t("passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="border-neutral-200 bg-white pr-9 text-neutral-900 placeholder:text-neutral-400 focus-visible:border-[#EE0000] focus-visible:ring-[#EE0000]/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-[#EE0000] text-white hover:bg-[#AA0000] disabled:opacity-50"
            >
              {loading ? t("signingIn") : t("signIn")}
            </Button>
          </form>

          <div className="mt-6 flex items-center gap-3" role="separator">
            <div className="h-px flex-1 bg-neutral-200" />
            <span className="text-xs text-neutral-400">{t("orDivider")}</span>
            <div className="h-px flex-1 bg-neutral-200" />
          </div>

          <p className="mt-4 text-center text-sm text-neutral-500">
            {t("noAccount")}{" "}
            <Link
              href={
                inviteToken
                  ? `/signup?invite=${encodeURIComponent(inviteToken)}`
                  : "/signup"
              }
              className="font-medium text-[#EE0000] hover:text-[#AA0000]"
            >
              {t("createAccount")}
            </Link>
          </p>
        </div>
      </div>

      {/* Right — painel institucional. Oculto em telas pequenas para
          manter o formulário como foco no mobile. */}
      <div className="relative hidden overflow-hidden bg-black lg:flex lg:w-1/2 lg:flex-col lg:p-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 65% 20%, rgba(255,80,80,0.55), transparent 50%), linear-gradient(160deg, #3a0000 0%, #7a0000 40%, #0a0000 100%)",
          }}
        />

        {/* brightness-0 invert: a logo é vermelha por natureza — vira uma
            silhueta branca aqui para garantir contraste em cima do painel
            escuro, independente do tom exato do gradiente. */}
        <SuperMassaLogo
          height={48}
          className="relative shrink-0 opacity-95 brightness-0 invert"
        />

        <div className="relative flex flex-1 flex-col justify-center">
          <h2 className="text-5xl leading-tight font-bold text-white">
            SPM Ticket
          </h2>
          <p className="mt-2 text-xl text-white/80">
            Sistema de atendimento e gestão de tickets
          </p>
          <p className="mt-6 max-w-md text-base leading-relaxed text-white/60">
            Centralize conversas, organize setores e distribua demandas com
            agilidade e eficiência.
          </p>
          <p className="mt-4 max-w-md text-base leading-relaxed text-white/60">
            Mais controle, mais produtividade e melhor experiência para sua
            equipe e seus clientes.
          </p>
        </div>
      </div>
    </div>
  );
}
