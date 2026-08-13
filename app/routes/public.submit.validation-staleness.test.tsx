import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorToast, FieldInput } from "~/components/submit/fields";
import type { FormFieldRef } from "~/lib/form-schema";
import { TRACK_KEY } from "~/lib/public-submit/wizard";

import { blockingSubmissionErrors, resolveSubmissionError } from "./public.submit.step";

const titleField: FormFieldRef = {
  fieldId: "field-title",
  key: "title",
  type: "text",
  label: "Title",
  scope: "submission",
  order: 0,
  required: true,
};

function fieldMarkup(error: string | null): string {
  return renderToStaticMarkup(
    <FieldInput field={titleField} value="A valid title" error={error} required />,
  );
}

describe("submission-step live errors replace stale server errors", () => {
  it("clears a rejected field and the toast after every rejected field becomes valid", () => {
    const serverErrors = { title: "A title is required.", takeaways: "Add takeaways." };
    const errorFor = (key: string) =>
      resolveSubmissionError({
        key,
        mode: "abstract",
        touched: true,
        liveError: undefined,
        serverError: serverErrors[key as keyof typeof serverErrors],
      });

    const html = fieldMarkup(errorFor("title"));
    expect(html).not.toContain("A title is required.");
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain("border-red-500");

    const blocking = blockingSubmissionErrors(serverErrors, errorFor);
    expect(blocking).toEqual([]);
    const toast = renderToStaticMarkup(
      blocking.length ? <ErrorToast title="Missing" body="Fix the fields." /> : <></>,
    );
    expect(toast).not.toContain('data-testid="error-toast"');
  });

  it("keeps an untouched server rejection visible", () => {
    const error = resolveSubmissionError({
      key: "title",
      mode: "abstract",
      touched: false,
      liveError: undefined,
      serverError: "A title is required.",
    });

    const html = fieldMarkup(error);
    expect(html).toContain("A title is required.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("border-red-500");
  });

  it("shows the live message when a touched field is still invalid", () => {
    const error = resolveSubmissionError({
      key: "title",
      mode: "abstract",
      touched: true,
      liveError: "Use at least 10 characters.",
      serverError: "A title is required.",
    });

    const html = fieldMarkup(error);
    expect(html).toContain("Use at least 10 characters.");
    expect(html).not.toContain("A title is required.");
    expect(html).toContain("border-red-500");
  });

  it("keeps the video-mode abstract exception on the server message", () => {
    expect(
      resolveSubmissionError({
        key: "abstract",
        mode: "video",
        touched: true,
        liveError: undefined,
        serverError: "Write an abstract.",
      }),
    ).toBe("Write an abstract.");
  });

  it("lets a touched valid programme-track choice clear its server rejection", () => {
    expect(
      resolveSubmissionError({
        key: TRACK_KEY,
        mode: "abstract",
        touched: true,
        liveError: undefined,
        serverError: "Choose a programme track.",
      }),
    ).toBeNull();
    expect(
      resolveSubmissionError({
        key: TRACK_KEY,
        mode: "abstract",
        touched: false,
        liveError: undefined,
        serverError: "Choose a programme track.",
      }),
    ).toBe("Choose a programme track.");
  });
});

describe("error toast layout", () => {
  it("renders in normal flow instead of pinning itself over the mobile footer", () => {
    const html = renderToStaticMarkup(<ErrorToast title="Missing" body="Fix the fields." />);

    expect(html).toContain('role="alert"');
    expect(html).toContain('data-testid="error-toast"');
    expect(html).toContain("mt-4");
    expect(html).toContain("max-w-full");
    expect(html).not.toMatch(/class="[^"]*\b(?:fixed|absolute|sticky)\b/);
    expect(html).not.toContain("bottom-3");
  });
});
