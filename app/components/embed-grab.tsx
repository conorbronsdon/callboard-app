import { linkClass } from "~/components/shell";
import type { EmbedWidgetId } from "~/lib/embeds";

export function EmbedGrabLink({
  widget,
  children,
  className,
  testId,
}: {
  widget: EmbedWidgetId;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <a
      href={`/admin/embeds?w=${widget}`}
      data-testid={testId}
      className={className ?? `${linkClass} text-sm`}
    >
      {children}
    </a>
  );
}

export function EmbedGrabCard() {
  return (
    <section
      data-testid="embed-grab-card"
      className="rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-4 dark:border-gray-700 dark:bg-gray-900/40"
    >
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Embed this event</p>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Grab ready-to-paste code for this event's public widgets.
      </p>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <EmbedGrabLink widget="schedule">Embed the schedule</EmbedGrabLink>
        <EmbedGrabLink widget="speakers">Embed the speaker directory</EmbedGrabLink>
        <a href="/admin/embeds" className={`${linkClass} text-sm`}>
          All embeds →
        </a>
      </p>
    </section>
  );
}
