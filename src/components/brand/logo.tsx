import Image from "next/image";
import { cn } from "@/lib/utils";
import supermassaIcon from "../../../public/brand/supermassa-icon.png";
import supermassaLogo from "../../../public/brand/supermassa-logo.png";

/** Símbolo da marca (losangos SuperMassa) em um badge quadrado vermelho. */
export function BrandMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg bg-white shadow-sm ring-1 ring-black/5",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Image
        src={supermassaIcon}
        alt=""
        className="h-[70%] w-auto object-contain"
        priority
      />
    </span>
  );
}

/** Ícone + nome do produto — usado onde "SPM Ticket" precisa aparecer ao lado da marca. */
export function BrandLockup({
  markSize = 32,
  className,
  textClassName,
  subtitleClassName,
  subtitle,
}: {
  markSize?: number;
  className?: string;
  textClassName?: string;
  subtitleClassName?: string;
  /** Linha pequena abaixo de "SPM Ticket" (ex.: "CRM de Atendimento"). Omitida por padrão — só a tela de login usa hoje. */
  subtitle?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <BrandMark size={markSize} />
      <span className="flex flex-col leading-tight">
        <span className={cn("text-sm font-semibold text-neutral-900", textClassName)}>
          SPM Ticket
        </span>
        {subtitle && (
          <span className={cn("text-xs text-neutral-500", subtitleClassName)}>{subtitle}</span>
        )}
      </span>
    </span>
  );
}

/** Losango grande e translúcido, usado como elemento decorativo de fundo (ex.: painel institucional do login). */
export function BrandWatermark({ className }: { className?: string }) {
  return (
    <Image
      src={supermassaIcon}
      alt=""
      aria-hidden
      className={cn("pointer-events-none w-auto object-contain select-none", className)}
    />
  );
}

/** Logotipo institucional completo da SuperMassa (ícone + "PRODUTOS SuperMassa"). */
export function SuperMassaLogo({
  className,
  height = 28,
}: {
  className?: string;
  height?: number;
}) {
  const width = Math.round((height * supermassaLogo.width) / supermassaLogo.height);
  return (
    <Image
      src={supermassaLogo}
      alt="SuperMassa"
      width={width}
      height={height}
      className={className}
    />
  );
}
