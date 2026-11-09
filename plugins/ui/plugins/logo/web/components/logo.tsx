import { useId } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { LOGO, logoPath, logoStroke, type LogoMaster } from "../../core";

export type LogoProps = {
  /** Sizes the logo (`size-5`, `size-sidebar-brand-mark`, …). */
  className?: string;
  /** The brand gradient, or the surrounding text colour (quiet chrome). */
  tone?: "gradient" | "current";
};

/**
 * The equin logo. Holds both masters and shows the small one when it is drawn
 * narrower than `LOGO.smallBelowPx` (a container query on its own box), so a
 * caller only sizes it. Decorative: hidden from the a11y tree.
 */
export function Logo({ className, tone = "gradient" }: LogoProps) {
  return (
    <span
      aria-hidden
      // eslint-disable-next-line layout/no-adhoc-layout -- the logo's own box: the container its master switch queries, sized by the caller
      className={cn("@container inline-block shrink-0", className)}
    >
      <LogoSvg
        master="full"
        tone={tone}
        className="block size-full @max-[27.99px]:hidden"
      />
      <LogoSvg
        master="small"
        tone={tone}
        className="hidden size-full @max-[27.99px]:block"
      />
    </span>
  );
}

function LogoSvg({
  master,
  tone,
  className,
}: {
  master: LogoMaster;
  tone: "gradient" | "current";
  className: string;
}) {
  const id = useId();
  const g = LOGO.gradient;
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className}>
      {tone === "gradient" && (
        <defs>
          <linearGradient
            id={id}
            gradientUnits="userSpaceOnUse"
            x1={g.x1}
            y1={g.y1}
            x2={g.x2}
            y2={g.y2}
          >
            <stop offset="0" stopColor={g.from} />
            <stop offset="1" stopColor={g.to} />
          </linearGradient>
        </defs>
      )}
      <path
        d={logoPath(master)}
        stroke={tone === "gradient" ? `url(#${id})` : "currentColor"}
        strokeWidth={logoStroke(master)}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
