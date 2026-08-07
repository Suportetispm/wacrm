"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Building2,
  LayoutDashboard,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface AdminNavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
}

const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { href: "/admin", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/admin/accounts", labelKey: "accounts", icon: Building2 },
  { href: "/admin/users", labelKey: "users", icon: Users },
  { href: "/admin/audit", labelKey: "audit", icon: ScrollText },
];

/**
 * Shell for the whole /admin (Superadmin) area — completely separate
 * navigation from the tenant Sidebar (src/components/layout/sidebar.tsx).
 * Authorization already happened server-side in admin/layout.tsx
 * before this ever renders; this component is presentation only.
 *
 * Responsive: a horizontal, scrollable tab bar on small screens, a
 * static left rail from lg+ — same breakpoint the tenant shell uses,
 * but a much simpler mechanism (no drawer/overlay) since the admin
 * nav is only 4 items.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Admin.nav");
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-4 py-3 lg:hidden">
        <Link href="/admin" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold text-foreground">
            {t("title")}
          </span>
        </Link>
        <Link
          href="/dashboard"
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {t("backToApp")}
        </Link>
      </header>

      <nav
        aria-label={t("title")}
        className="shrink-0 border-b border-border bg-card lg:w-60 lg:border-r lg:border-b-0"
      >
        <div className="hidden h-14 items-center gap-2 border-b border-border px-4 lg:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold text-foreground">
            {t("title")}
          </span>
        </div>

        <ul className="flex gap-1 overflow-x-auto px-3 py-2 lg:flex-col lg:overflow-visible lg:px-3 lg:py-4">
          {ADMIN_NAV_ITEMS.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/admin" && pathname.startsWith(item.href));
            return (
              <li key={item.href} className="shrink-0 lg:shrink">
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors lg:gap-3 lg:py-2.5",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {t(item.labelKey)}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="hidden border-t border-border p-3 lg:block">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t("backToApp")}
          </Link>
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
    </div>
  );
}
