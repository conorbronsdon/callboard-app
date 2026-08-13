/**
 * Client-only boundary.
 *
 * React Router framework mode server-renders everything by default. Anything
 * that touches `window`, measures the DOM, or (the reason this exists) runs
 * @dnd-kit must not render on the server. Wrap it:
 *
 *   <ClientOnly fallback={<AgendaSkeleton />}>
 *     {() => <DragDropGrid ... />}
 *   </ClientOnly>
 *
 * `children` is a FUNCTION on purpose — that keeps the subtree from even being
 * constructed during SSR, which a plain `{cond && <X/>}` does not guarantee for
 * modules with import-time side effects.
 */
import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/** True once React has hydrated on the client. False during SSR. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

export function ClientOnly({
  children,
  fallback = null,
}: {
  children: () => React.ReactNode;
  fallback?: React.ReactNode;
}) {
  return useHydrated() ? <>{children()}</> : <>{fallback}</>;
}

export default ClientOnly;
