// ============================================================
// Autorização em escopo de plataforma.
//
// Este módulo é completamente separado da autorização de tenant
// existente em `@/lib/auth/account`, `getCurrentAccount()` e
// `requireRole()`.
//
// Um Superadmin opera no nível global da plataforma. Por isso,
// este módulo:
//
// - não consulta profiles.account_id;
// - não consulta profiles.account_role;
// - não usa getCurrentAccount();
// - não usa requireRole();
// - não considera owner ou admin de tenant como Superadmin.
//
// A única fonte de verdade para autorização global é a RPC
// SECURITY DEFINER `is_platform_admin()`.
//
// A tabela public.platform_admins não possui policies RLS para
// authenticated ou anon. Portanto, o navegador não consegue
// consultá-la diretamente.
// ============================================================

import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

export class PlatformUnauthorizedError extends Error {
  readonly status = 401 as const;

  constructor(message = "Unauthorized") {
    super(message);
    this.name = "PlatformUnauthorizedError";
  }
}

export class PlatformForbiddenError extends Error {
  readonly status = 403 as const;

  constructor(message = "Forbidden") {
    super(message);
    this.name = "PlatformForbiddenError";
  }
}

/**
 * Converte erros de autorização da plataforma em respostas HTTP
 * sanitizadas.
 *
 * Esta implementação permanece separada do módulo de autorização
 * de tenant para evitar dependência ou mistura entre os dois
 * contextos de segurança.
 */
export function toPlatformErrorResponse(err: unknown): NextResponse {
  if (
    err instanceof PlatformUnauthorizedError ||
    err instanceof PlatformForbiddenError
  ) {
    return NextResponse.json(
      { error: err.message },
      { status: err.status },
    );
  }

  // O objeto original do erro não é registrado para evitar exposição
  // acidental de detalhes internos, informações de infraestrutura,
  // sessão ou outros dados sensíveis.
  console.error(
    "[toPlatformErrorResponse] unexpected platform auth error",
  );

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 },
  );
}

/**
 * Contexto mínimo retornado após a autorização do Superadmin.
 *
 * O cliente Supabase não é retornado propositalmente. O cliente SSR
 * utilizado para autenticação é sujeito às regras normais de RLS e
 * não deve ser confundido com um futuro cliente administrativo
 * server-only para operações cross-tenant.
 */
export interface PlatformAdminContext {
  userId: string;
}

/**
 * Valida se o usuário atual está autenticado e possui privilégio
 * global de Superadmin.
 *
 * Retorna:
 * - PlatformUnauthorizedError quando não existe sessão válida;
 * - PlatformForbiddenError quando o usuário está autenticado, mas
 *   não possui privilégio global.
 *
 * Esta função deliberadamente:
 * - não recebe account_id;
 * - não consulta profiles;
 * - não chama getCurrentAccount();
 * - não chama requireRole();
 * - não utiliza roles de tenant como fallback.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    throw new PlatformUnauthorizedError();
  }

  // A RPC não recebe user_id como argumento. Ela verifica somente
  // auth.uid() dentro do banco, impedindo que o cliente consulte o
  // privilégio de outro usuário.
  const { data: isAdmin, error: rpcErr } = await supabase.rpc(
    "is_platform_admin",
  );

  if (rpcErr) {
    // Falha fechada: se a verificação do privilégio não puder ser
    // concluída com segurança, o acesso é negado.
    //
    // O objeto da falha não é registrado para evitar exposição de
    // detalhes internos da RPC ou do banco.
    console.error(
      "[requirePlatformAdmin] platform admin check failed",
    );

    throw new PlatformForbiddenError();
  }

  if (!isAdmin) {
    throw new PlatformForbiddenError();
  }

  // Retorna somente a identidade já autenticada e autorizada.
  // Nenhum cliente Supabase ou contexto de tenant é exposto.
  return {
    userId: user.id,
  };
}