"use client";

import { useTranslations } from "next-intl";
import { Construction } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface AdminPlaceholderProps {
  titleKey: string;
  descKey: string;
}

/** Prepared-but-not-yet-functional /admin sections (Dashboard, Usuários,
 *  Auditoria) — Empresas is the only one wired to real data this phase. */
export function AdminPlaceholder({ titleKey, descKey }: AdminPlaceholderProps) {
  const t = useTranslations("Admin.placeholder");

  return (
    <Card className="border-dashed">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
          <Construction className="h-6 w-6 text-muted-foreground" />
        </div>
        <CardTitle className="text-foreground">{t(titleKey)}</CardTitle>
        <CardDescription>{t(descKey)}</CardDescription>
      </CardHeader>
      <CardContent className="text-center text-sm text-muted-foreground">
        {t("comingSoon")}
      </CardContent>
    </Card>
  );
}
