/**
 * Portal chrome. The speaker portal has its own visual signature in
 * Sessionboard — no left rail, centred content, cards with a solid coloured
 * header bar — so it gets its own small component set rather than reusing the
 * admin `Shell` internals.
 *
 * Everything here is mobile-first: the acceptance criterion is a speaker
 * completing every task at a 375px viewport, so nothing may set a fixed width
 * and wide content scrolls inside its own container.
 */
import { Link } from "react-router";

import type { StatusTone } from "~/lib/portal-progress";

/* ---------------------------------------------------------------- cards */

export function Card({
  title,
  action,
  tone = "brand",
  children,
}: {
  title: string;
  action?: React.ReactNode;
  tone?: "brand" | "plain";
  children: React.ReactNode;
}) {
  return (
    /*
     * `h-full` + a growing body. Two cards side by side in a `md:grid-cols-2`
     * row are stretched to the taller one, and the shorter card's content used
     * to stop where its text ran out — the portal's profile card ended with
     * 90px of white below its button while the tasks card beside it was full to
     * the edge. The body grows instead, so a card can pin its own action.
     */
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-card dark:border-gray-800 dark:bg-gray-900">
      <header
        className={[
          "flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm font-semibold",
          tone === "brand"
            ? "bg-blue-600 text-white"
            : "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100",
        ].join(" ")}
      >
        <h2>{title}</h2>
        {action ? <div className="text-xs font-normal">{action}</div> : null}
      </header>
      <div className="flex flex-1 flex-col p-4">{children}</div>
    </section>
  );
}

/** Zero-state copy. Every screen has one; AGENTS.md rule 3 makes it a done-when. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center dark:border-gray-700">
      <p className="text-sm font-medium">{title}</p>
      {children ? (
        <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500 dark:text-gray-400">{children}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- status */

const TONE_CLASSES: Record<StatusTone, string> = {
  positive:
    "bg-green-100 text-green-900 ring-green-600/20 dark:bg-green-950 dark:text-green-200 dark:ring-green-400/30",
  warning:
    "bg-amber-100 text-amber-900 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/30",
  neutral:
    "bg-gray-100 text-gray-700 ring-gray-500/20 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-400/30",
  negative:
    "bg-rose-100 text-rose-900 ring-rose-600/20 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-400/30",
};

/**
 * Status is carried by a glyph AND a word, never by colour alone — the tone
 * class is decoration on top of text that already says everything.
 */
export function StatusPill({
  tone,
  glyph,
  children,
}: {
  tone: StatusTone;
  glyph?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]}`}
    >
      {glyph ? <span aria-hidden="true">{glyph}</span> : null}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------- buttons */

const BUTTON_BASE =
  "inline-flex items-center justify-center rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50";

/*
 * Two sizes, not a scale. `sm` exists for buttons that live inside a table row
 * — a full-height control repeated down eighteen rows turns a list into a wall.
 * It is a size TOKEN rather than a caller-supplied `px-2.5 py-1` override
 * because Tailwind resolves conflicting utilities by stylesheet order, not by
 * the order they appear in the class attribute: appending `px-2.5` to a string
 * that already carries `px-3.5` is a coin flip, not an override.
 */
const BUTTON_SIZE = {
  md: "gap-2 px-3.5 py-2 text-sm",
  sm: "gap-1.5 px-2.5 py-1 text-xs",
} as const;

export const buttonClass = (
  variant: "primary" | "secondary" | "danger" = "primary",
  size: keyof typeof BUTTON_SIZE = "md",
) =>
  [
    BUTTON_BASE,
    BUTTON_SIZE[size],
    variant === "primary"
      ? "bg-blue-600 text-white hover:bg-blue-700"
      : variant === "danger"
        ? "border border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
        : "border border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800",
  ].join(" ");

/* --------------------------------------------------------------- meters */

export function ProgressMeter({
  percent,
  label,
}: {
  percent: number;
  label: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs text-gray-600 dark:text-gray-400">
        <span>{label}</span>
        <span className="font-medium tabular-nums">{percent}%</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={percent === 100 ? "h-full bg-green-600" : "h-full bg-blue-600"}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- misc */

export function Avatar({
  name,
  email,
  src,
  size = "md",
}: {
  name: string | null;
  email: string;
  src?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const dimension = size === "lg" ? "h-20 w-20 text-2xl" : size === "sm" ? "h-8 w-8 text-xs" : "h-12 w-12 text-base";
  const initials = (name ?? email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  if (src) {
    return (
      <img
        src={src}
        alt={name ?? email}
        className={`${dimension} shrink-0 rounded-full object-cover ring-1 ring-gray-200 dark:ring-gray-700`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${dimension} inline-flex shrink-0 items-center justify-center rounded-full bg-blue-100 font-semibold text-blue-900 dark:bg-blue-950 dark:text-blue-200`}
    >
      {initials || "?"}
    </span>
  );
}

/** Inline error/success strip used by every portal form. */
export function Notice({
  tone,
  children,
}: {
  tone: "error" | "success" | "info";
  children: React.ReactNode;
}) {
  const classes =
    tone === "error"
      ? "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
      : tone === "success"
        ? "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
        : "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-lg border px-3 py-2 text-sm ${classes}`}
    >
      {children}
    </div>
  );
}

export function FieldLabel({
  htmlFor,
  children,
  hint,
  required,
}: {
  htmlFor: string;
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium">
      {children}
      {required ? (
        <span className="text-rose-600" aria-hidden="true">
          {" "}
          *
        </span>
      ) : null}
      {hint ? (
        <span className="mt-0.5 block text-xs font-normal text-gray-500 dark:text-gray-400">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "mt-1.5 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm " +
  "focus:border-blue-500 focus:ring-2 focus:ring-blue-200 focus:outline-none " +
  "dark:border-gray-700 dark:bg-gray-950 dark:focus:ring-blue-900";

/** Link styled as a button, for next-action nudges. */
export function ButtonLink({
  to,
  variant = "primary",
  children,
}: {
  to: string;
  variant?: "primary" | "secondary";
  children: React.ReactNode;
}) {
  return (
    <Link to={to} className={buttonClass(variant)}>
      {children}
    </Link>
  );
}
