/**
 * The chrome-less frame every embed widget renders inside.
 *
 * One module so the widgets cannot drift on the two things that make an embed
 * an embed: the theme override, and the absence of site chrome. There is no
 * topbar, no nav and no `SiteFooter` here on purpose — a host page supplies its
 * own, and a second one inside an iframe reads as a broken page.
 *
 * `theme` beats the visitor's OS preference because the person choosing it is
 * the host page's operator, matching the surrounding page. `auto` keeps
 * `prefers-color-scheme`, which is the default everywhere else in the app.
 */
import type { CSSProperties } from "react";

import { eyebrowClass } from "~/components/shell";
import type { EmbedDensity, EmbedTheme } from "~/lib/embeds";

export function EmbedShell({
  theme,
  accent = null,
  density = "full",
  eyebrow,
  title,
  testId,
  sourceHref,
  children,
}: {
  theme: EmbedTheme;
  accent?: string | null;
  density?: EmbedDensity;
  eyebrow: string;
  title: string;
  testId: string;
  sourceHref: string;
  children: React.ReactNode;
}) {
  const themeClass =
    theme === "dark" ? "cb-theme-dark" : theme === "light" ? "cb-theme-light" : "";
  const style =
    theme === "auto" && !accent
      ? undefined
      : ({
          ...(theme === "auto" ? {} : { colorScheme: theme }),
          ...(accent ? { "--cb-accent": accent } : {}),
        } as CSSProperties);

  return (
    <div
      className={`${themeClass} min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100 ${density === "compact" ? "px-2 py-3 sm:px-3" : "px-3 py-4 sm:px-4"}`}
      style={style}
      data-testid={testId}
      data-embed-theme={theme}
      data-embed-density={density}
      {...(accent ? { "data-embed-accent": accent } : {})}
    >
      <header className="mb-4">
        <p
          className={`${eyebrowClass} tracking-wide`}
          style={accent ? { color: "var(--cb-accent)" } : undefined}
        >
          {eyebrow}
        </p>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <div
          aria-hidden="true"
          className={`mt-2 h-1 w-12 rounded-full ${accent ? "" : "bg-gray-300 dark:bg-gray-700"}`}
          style={accent ? { background: "var(--cb-accent)" } : undefined}
        />
      </header>
      {children}
      <p className="mt-5 text-center text-xs text-gray-500 dark:text-gray-400">
        {/*
         * `target="_blank"`: the widget is inside somebody else's iframe, so a
         * same-tab navigation would replace the WIDGET, not the host page —
         * leaving the visitor stranded in a frame-sized copy of the site.
         */}
        <a
          className="font-medium underline-offset-4 hover:underline"
          href={sourceHref}
          target="_blank"
          rel="noopener"
        >
          Powered by callboard
        </a>
      </p>
    </div>
  );
}
