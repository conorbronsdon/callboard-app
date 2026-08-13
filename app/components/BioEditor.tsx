/**
 * WYSIWYG-lite bio editor.
 *
 * Sessionboard's portal Biography field is a REDUCED rich-text editor (bold /
 * italic / lists / link / clear formatting) with a live `0 / 5,000 characters`
 * counter. Shipping a real contenteditable rich-text editor means shipping a
 * sanitiser for its output and an HTML-to-storage story; markdown with a
 * formatting toolbar gets the same job done, stores as plain text, and renders
 * through `renderMarkdown` (which is itself sanitised).
 *
 * Interactivity is a React event handler over a textarea ref — no `window` at
 * module scope, so this SSRs fine and needs no `<ClientOnly>` wrapper. Without
 * JS it degrades to a plain textarea that still submits.
 */
import { useRef, useState } from "react";

interface ToolbarAction {
  label: string;
  title: string;
  /** Wrap the selection, or insert at the caret when nothing is selected. */
  before: string;
  after?: string;
  /** Prefix each selected line instead of wrapping (lists, quotes). */
  linePrefix?: string;
}

const ACTIONS: ToolbarAction[] = [
  { label: "B", title: "Bold", before: "**", after: "**" },
  { label: "I", title: "Italic", before: "*", after: "*" },
  { label: "Link", title: "Link", before: "[", after: "](https://)" },
  { label: "• List", title: "Bulleted list", before: "", linePrefix: "- " },
  { label: "1. List", title: "Numbered list", before: "", linePrefix: "1. " },
  { label: "❝", title: "Quote", before: "", linePrefix: "> " },
];

export function BioEditor({
  name,
  defaultValue,
  maxLength = 5000,
  id = "bio",
}: {
  name: string;
  defaultValue: string;
  maxLength?: number;
  id?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(defaultValue);

  const apply = (action: ToolbarAction) => {
    const textarea = ref.current;
    if (!textarea) return;
    const { selectionStart, selectionEnd } = textarea;
    const selected = value.slice(selectionStart, selectionEnd);

    let replacement: string;
    if (action.linePrefix) {
      const lines = (selected || "List item").split("\n");
      replacement = lines
        .map((line, index) =>
          action.linePrefix === "1. " ? `${index + 1}. ${line}` : `${action.linePrefix}${line}`,
        )
        .join("\n");
    } else {
      replacement = `${action.before}${selected || "text"}${action.after ?? ""}`;
    }

    const next = value.slice(0, selectionStart) + replacement + value.slice(selectionEnd);
    setValue(next.slice(0, maxLength));

    // Restore focus and put the caret after what we just inserted.
    requestAnimationFrame(() => {
      textarea.focus();
      const caret = selectionStart + replacement.length;
      textarea.setSelectionRange(caret, caret);
    });
  };

  const over = value.length > maxLength;

  return (
    <div>
      <div className="flex flex-wrap gap-1 rounded-t-lg border border-b-0 border-gray-300 bg-gray-50 p-1.5 dark:border-gray-700 dark:bg-gray-800">
        {ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            title={action.title}
            aria-label={action.title}
            onClick={() => apply(action)}
            className="rounded px-2 py-1 text-xs font-medium text-gray-700 hover:bg-white dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {action.label}
          </button>
        ))}
        <span className="ml-auto self-center px-1 text-[11px] text-gray-500 dark:text-gray-400">
          Markdown
        </span>
      </div>
      <textarea
        ref={ref}
        id={id}
        name={name}
        rows={8}
        maxLength={maxLength}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Enter text here…"
        className="block w-full rounded-b-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 focus:outline-none dark:border-gray-700 dark:bg-gray-950 dark:focus:ring-blue-900"
      />
      <p
        className={`mt-1 text-right text-xs tabular-nums ${over ? "font-medium text-rose-600" : "text-gray-500 dark:text-gray-400"}`}
        aria-live="polite"
      >
        {value.length.toLocaleString()} / {maxLength.toLocaleString()} characters
      </p>
    </div>
  );
}
