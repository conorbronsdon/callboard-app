/**
 * Renders one form field as an input.
 *
 * Controlled by the step component so the live counters, conditional
 * show/hide and cross-field totals all read one answers object. Every input
 * carries a plain `name`, so the step still submits and validates with
 * JavaScript disabled — the client layer only adds liveness.
 *
 * `wysiwyg` renders as a textarea on purpose: the public form is the speed-
 * scored surface (AGENTS.md #8) and a rich-text editor is the single heaviest
 * thing that could go on it. Admin-side rich text is WS1a's call.
 */
import { textOf, type AnswerValue, type FormFieldRef } from "~/lib/public-submit/contract";
import {
  ACCEPT_ATTRIBUTE,
  PUBLIC_SUBMIT_FILE_PURPOSE,
  uploadConstraintText,
} from "~/lib/portal-uploads";

const BASE_INPUT =
  "w-full rounded border border-gray-300 bg-white px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-900";
const ERROR_INPUT = "border-red-500 dark:border-red-500";

export function FieldInput({
  field,
  namePrefix = "",
  value,
  error,
  onChange,
  required,
}: {
  field: FormFieldRef;
  /** Set for participant-scope fields, e.g. `p1.`. */
  namePrefix?: string;
  value: AnswerValue;
  error?: string | null;
  onChange?: (next: AnswerValue) => void;
  required: boolean;
}) {
  const rules = field.validation ?? {};
  const text = textOf(value, field.type);
  // Keep the display value raw while the counter strips wysiwyg HTML; passing field.type here would reintroduce the space-eating regression.
  const rawText = textOf(value);
  const name = `${namePrefix}${field.key}`;
  const id = `field-${name}`;
  /*
   * A file field ALWAYS states its limits (CNT-06), generated from the enforced
   * constants so the sentence cannot promise a cap the validator does not apply.
   *
   * Appended to the author's help text rather than replacing it. `?? ` looked
   * equivalent and was not: any file field whose author had written a hint lost
   * the constraint sentence entirely, and `helpText: ""` — which `??` does not
   * catch — rendered no copy at all. "At every upload control" has to mean every
   * one, or the claim is just untested for the fields that have authors.
   *
   * The purpose is `PUBLIC_SUBMIT_FILE_PURPOSE` because that is what the server
   * stores these under; stating "document" while storing "other" only looked
   * right because the two accept-lists are equal today.
   */
  const constraint = uploadConstraintText(PUBLIC_SUBMIT_FILE_PURPOSE);
  const authored = field.helpText?.trim();
  const helpText =
    field.type === "file"
      ? authored
        ? `${authored} ${constraint}`
        : constraint
      : field.helpText;

  const describedBy = [error ? `${id}-error` : null, helpText ? `${id}-help` : null]
    .filter(Boolean)
    .join(" ");

  const className = [BASE_INPUT, error ? ERROR_INPUT : ""].join(" ").trim();
  const common = {
    id,
    name,
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": describedBy || undefined,
    className,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
    ) => onChange?.(event.target.value),
  };

  let control: React.ReactNode;
  switch (field.type) {
    case "textarea":
    case "wysiwyg":
      control = (
        <textarea
          {...common}
          value={rawText}
          rows={field.type === "wysiwyg" ? 8 : 4}
          maxLength={rules.maxLength}
        />
      );
      break;
    case "select":
    case "radio":
      control = (
        <select {...common} value={text}>
          <option value="">Select…</option>
          {(rules.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
      break;
    case "multiselect":
      control = (
        <select
          {...common}
          multiple
          value={Array.isArray(value) ? value : text ? [text] : []}
          onChange={(event) =>
            onChange?.(Array.from(event.target.selectedOptions, (option) => option.value))
          }
          size={Math.min(5, (rules.options ?? []).length || 3)}
        >
          {(rules.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
      break;
    case "boolean":
    case "checkbox":
      control = (
        <label className="flex items-center gap-2 text-sm">
          <input
            id={id}
            name={name}
            type="checkbox"
            value="yes"
            checked={text === "yes" || text === "true"}
            aria-describedby={describedBy || undefined}
            onChange={(event) => onChange?.(event.target.checked ? "yes" : "")}
            className="h-4 w-4"
          />
          <span>{field.helpText ?? "Yes"}</span>
        </label>
      );
      break;
    case "number":
      control = (
        <input {...common} type="number" value={text} min={rules.min} max={rules.max} />
      );
      break;
    case "date":
      control = <input {...common} type="date" value={text} />;
      break;
    case "email":
      control = <input {...common} type="email" value={text} inputMode="email" />;
      break;
    case "phone":
      control = <input {...common} type="tel" value={text} inputMode="tel" />;
      break;
    case "url":
    case "video_url":
      control = (
        <input {...common} type="url" value={text} inputMode="url" placeholder="https://" />
      );
      break;
    case "file":
      // CNT-06: the picker filters by the SAME list the server validates
      // against, for the SAME purpose the server stores under, and the
      // constraint is also stated in words above.
      control = (
        <input
          id={id}
          name={name}
          type="file"
          accept={ACCEPT_ATTRIBUTE[PUBLIC_SUBMIT_FILE_PURPOSE]}
          className={className}
        />
      );
      break;
    default:
      control = <input {...common} type="text" value={text} maxLength={rules.maxLength} />;
  }

  const showCounter =
    rules.maxLength !== undefined &&
    (["text", "textarea", "wysiwyg"] as string[]).includes(field.type);

  return (
    <div className="mb-5" data-field={field.key}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {field.label}
          {required ? <span className="text-red-600"> *</span> : null}
        </label>
        {showCounter ? (
          <span
            data-testid={`counter-${field.key}`}
            className={
              text.length > (rules.maxLength ?? 0)
                ? "text-xs text-red-600"
                : "text-xs text-gray-500 dark:text-gray-400"
            }
          >
            {text.length}/{rules.maxLength}
          </span>
        ) : null}
      </div>
      {helpText && field.type !== "boolean" && field.type !== "checkbox" ? (
        <p id={`${id}-help`} className="mb-1 text-xs text-gray-500 dark:text-gray-400">
          {helpText}
        </p>
      ) : null}
      {control}
      {error ? (
        <p id={`${id}-error`} data-testid={`error-${name}`} className="mt-1 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The cross-field combined counter. Shows the live total across several fields
 * and turns red past the cap.
 *
 * `countedLabels` are the labels the submitter sees on those inputs, never the
 * field keys — "(combined across title, takeaways)" is only meaningful if the
 * words match the headings above the boxes they are typing in.
 */
export function CombinedCounterBox({
  ruleId,
  label,
  used,
  max,
  countedLabels,
}: {
  ruleId: string;
  label: string;
  used: number;
  max: number;
  countedLabels: string[];
}) {
  const over = used > max;
  return (
    <div
      data-testid={`combined-limit-${ruleId}`}
      data-over={over ? "true" : "false"}
      className={[
        "mb-5 rounded border px-3 py-2 text-sm",
        over
          ? "border-red-400 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
          : "border-gray-200 text-gray-600 dark:border-gray-800 dark:text-gray-300",
      ].join(" ")}
    >
      <span className="font-medium">{label}:</span>{" "}
      <span data-testid={`combined-count-${ruleId}`}>
        {used} / {max} characters
      </span>
      {countedLabels.length ? (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {" "}
          (combined across {countedLabels.join(", ")})
        </span>
      ) : null}
      {over ? (
        <p className="mt-1 font-medium">
          {used - max} character{used - max === 1 ? "" : "s"} over the combined limit.
        </p>
      ) : null}
    </div>
  );
}

/** In-flow red error panel (walkthrough §12.3). No animation, no JS. */
export function ErrorToast({ title, body }: { title: string; body: string }) {
  return (
    <div
      role="alert"
      data-testid="error-toast"
      className="mt-4 w-full max-w-full rounded-lg bg-red-600 px-4 py-3 text-sm text-white shadow-lg sm:ml-auto sm:max-w-sm"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-0.5 opacity-90">{body}</p>
    </div>
  );
}
