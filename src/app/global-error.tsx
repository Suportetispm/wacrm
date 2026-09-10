"use client";

// Last-resort boundary: only fires when the ROOT layout itself throws
// (e.g. a bug in the theme boot script, font loading, or
// NextIntlClientProvider setup in src/app/layout.tsx) — every other
// error in the app is caught by a more specific error.tsx first (see
// src/app/error.tsx and the (dashboard)/(auth)/admin ones). Next.js
// requires global-error.tsx to render its own complete <html>/<body>,
// since it replaces the root layout wholesale.
//
// Deliberately self-contained: no NextIntlClientProvider (it lives
// INSIDE the root layout this file replaces, so it isn't available
// here), no shadcn/ui components, no Tailwind classes — anything that
// depends on the app's own CSS pipeline or provider tree having
// mounted correctly is exactly what might be broken when this file
// runs. Inline styles only, and a tiny hand-picked dictionary instead
// of the real i18n system, keyed off the same NEXT_PUBLIC_APP_LOCALE
// env var src/i18n/request.ts reads — inlined at build time since
// it's a NEXT_PUBLIC_ var, so no server call is needed to pick it.
//
// Same "never show error.message/stack" rule as every other
// error.tsx — only `error.digest` (Next.js's own opaque per-error
// reference) may be shown.

import { useEffect } from "react";

const COPY: Record<string, { title: string; description: string; retry: string; reference: string }> = {
  en: {
    title: "Something went wrong",
    description:
      "An unexpected error occurred and the page could not load. You can try again.",
    retry: "Try again",
    reference: "Reference",
  },
  "pt-BR": {
    title: "Algo deu errado",
    description:
      "Ocorreu um erro inesperado e a página não pôde carregar. Você pode tentar novamente.",
    retry: "Tentar novamente",
    reference: "Referência",
  },
  ko: {
    title: "문제가 발생했습니다",
    description: "예기치 않은 오류로 페이지를 불러올 수 없습니다. 다시 시도해 주세요.",
    retry: "다시 시도",
    reference: "참조 번호",
  },
};

function copyFor(locale: string | undefined) {
  return COPY[locale ?? "en"] ?? COPY.en;
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const copy = copyFor(process.env.NEXT_PUBLIC_APP_LOCALE);

  useEffect(() => {
    // Browser devtools console only — see error-boundary-fallback.tsx
    // for why this is safe to log as-is.
    console.error("[global-error]", error);
  }, [error]);

  return (
    <html>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#020617",
          color: "#f8fafc",
        }}
      >
        <div
          role="alert"
          aria-live="assertive"
          style={{
            width: "100%",
            maxWidth: "28rem",
            textAlign: "center",
            border: "1px solid rgba(248,250,252,0.12)",
            borderRadius: "0.75rem",
            padding: "2rem 1.5rem",
            background: "rgba(248,250,252,0.03)",
          }}
        >
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
            {copy.title}
          </h1>
          <p style={{ fontSize: "0.9rem", color: "rgba(248,250,252,0.7)", margin: "0 0 1.25rem" }}>
            {copy.description}
          </p>
          <button
            onClick={reset}
            style={{
              width: "100%",
              padding: "0.6rem 1rem",
              borderRadius: "0.5rem",
              border: "none",
              background: "#f8fafc",
              color: "#020617",
              fontSize: "0.9rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {copy.retry}
          </button>
          {error.digest ? (
            <p style={{ fontSize: "0.75rem", color: "rgba(248,250,252,0.5)", marginTop: "0.75rem" }}>
              {copy.reference}: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
