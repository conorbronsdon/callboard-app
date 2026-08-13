import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import { linkClass } from "./components/shell";
import type { Route } from "./+types/root";
import "./app.css";

/**
 * Inter is served from this origin (see app.css), so there is no third-party
 * stylesheet to fetch and no second origin to preconnect to — just the one
 * font file, preloaded so it is in flight alongside the CSS rather than after
 * it.
 */
export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    as: "font",
    type: "font/woff2",
    href: "/fonts/inter-latin-var.woff2",
    crossOrigin: "anonymous",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * The error page is a product screen too. A bare `<h1>404</h1>` on an unstyled
 * page reads as an app that fell over; this keeps the header, names what
 * happened in plain language, and always offers a way back.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let heading = "Something went wrong";
  let details = "That request could not be completed. Try again in a moment.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      heading = "Page not found";
      details =
        "That link does not point anywhere in callboard. It may have been moved, or the event may no longer be public.";
    } else {
      heading = `Something went wrong (${error.status})`;
      details = error.statusText || details;
    }
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 px-4 py-3.5">
          <a href="/" className="text-base font-semibold tracking-tight">
            callboard
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-16">
        <h1 className="text-2xl font-semibold">{heading}</h1>
        <p className="mt-2 max-w-prose text-sm text-gray-600 dark:text-gray-300">{details}</p>
        <p className="mt-6 flex flex-wrap gap-4 text-sm">
          <a href="/" className={linkClass}>
            Back to events
          </a>
          <a href="/portal" className={linkClass}>
            Speaker portal
          </a>
          <a href="/admin" className={linkClass}>
            Admin
          </a>
        </p>
        {stack ? (
          <pre className="mt-8 w-full overflow-x-auto rounded-xl border border-gray-200 bg-white p-4 text-xs dark:border-gray-800 dark:bg-gray-900">
            <code>{stack}</code>
          </pre>
        ) : null}
      </main>
    </div>
  );
}
