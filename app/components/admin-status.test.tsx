/**
 * The decision control has to look like a control.
 *
 * On an abstract's detail page the ONLY way to accept or decline is the small
 * coloured status pill, which is secretly a `<details>` summary. A cold reader
 * sees a label — pills are output everywhere else in this app, including in the
 * radio group inside this very popover — and there is nothing on it that says
 * "this one is clickable". The review decision, the single most consequential
 * action an organizer takes, was hidden behind a widget that reads as a badge.
 *
 * The flow is NOT redesigned here: same `<details>`, same form, same radios,
 * same save semantics. What changes is that the summary announces itself.
 *
 * Assertions are on rendered markup rather than on a class list, because the
 * defect was "nothing tells you it is a control" — a class name cannot answer
 * that. `StatusPill` is rendered on its own as the negative control: if the
 * affordance text leaked into the pill, the pill would start claiming to be
 * editable in the eight read-only places it appears (including inside this
 * popover's own options), and every assertion below would still pass.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusCell, StatusPill } from "./admin-status";

const CELL = () =>
  renderToStaticMarkup(
    <StatusCell
      sessionId="abs-1"
      status="pending"
      tab="pending"
      trackId={null}
      returnTo="/admin/submissions/abs-1"
    />,
  );

/** The `<summary>`'s INNER markup — what a sighted reader sees on the pill. */
function summaryOf(html: string): string {
  const match = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(html);
  if (!match) throw new Error("StatusCell rendered no <summary>");
  return match[1];
}

/**
 * The `<summary>` OPENING TAG, which is where the accessible name lives.
 *
 * Deliberately separate from `summaryOf`: the inner markup does not contain the
 * element's own attributes, so asserting `aria-label` against `summaryOf` reads
 * as a passing accessibility check while actually measuring whichever child
 * happened to carry a redundant label. It passed for exactly that reason until
 * the redundant one was removed.
 */
function summaryTagOf(html: string): string {
  const match = /<summary[^>]*>/.exec(html);
  if (!match) throw new Error("StatusCell rendered no <summary>");
  return match[0];
}

/* ──────────────────────────────── must-fire: the summary reads as a control ── */

describe("the status summary announces that it opens something", () => {
  it("carries a visible change affordance", () => {
    expect(summaryOf(CELL())).toMatch(/Change/);
  });

  it("carries a disclosure marker", () => {
    // `list-none` removes the native triangle, so the widget supplies its own.
    // Keyed off a data attribute rather than a glyph: an SVG, a caret or a
    // rotated chevron are all fine, an absent marker is not.
    expect(summaryOf(CELL())).toMatch(/data-status-disclosure/);
  });

  it("keeps the affordance inside the summary, where the click target is", () => {
    // "Change" rendered below the pill, outside the summary, would look like a
    // fix and click nothing.
    const html = CELL();
    expect(summaryOf(html)).toMatch(/Change/);
    expect(html.replace(/<summary[^>]*>[\s\S]*?<\/summary>/, "")).not.toMatch(/Change/);
  });

  it("names the control for a screen reader", () => {
    // On the element itself, not on a child: an accessible name on the summary
    // replaces its whole subtree for assistive tech, so this is the only place
    // the name can actually be announced from.
    expect(summaryTagOf(CELL())).toMatch(/aria-label="[^"]*[Ss]tatus[^"]*"/);
  });

  it("names the CURRENT status in that accessible name", () => {
    // "Change status" alone would announce a control with no state. The label
    // has to carry what the status currently IS, since the pill's text is
    // suppressed by the ancestor's accessible name.
    expect(summaryTagOf(CELL())).toMatch(/aria-label="[^"]*Pending[^"]*"/);
  });
});

/* ────────────────────── must-not-fire: the pill stays a pill everywhere else ── */

describe("the read-only pill is untouched", () => {
  it("renders no affordance text on its own", () => {
    const pill = renderToStaticMarkup(<StatusPill status="accepted" />);
    expect(pill).not.toMatch(/Change/);
    expect(pill).not.toMatch(/data-status-disclosure/);
    expect(pill).toMatch(/Accepted/);
  });

  it("still shows the current status inside the summary", () => {
    // The affordance must not displace the information. A summary that says
    // "Change" and no longer says "Pending" has traded one defect for another.
    expect(summaryOf(CELL())).toMatch(/Pending/);
  });
});

/* ─────────────────────────────── must-not-fire: the flow is not redesigned ── */

describe("the editor's mechanics are unchanged", () => {
  const html = CELL();

  it("keeps the details/summary disclosure", () => {
    expect(html).toMatch(/<details/);
    expect(html).toMatch(/<summary/);
  });

  it("keeps the JS-free post form and its test id", () => {
    expect(html).toMatch(/<form[^>]*method="post"/);
    expect(html).toMatch(/data-testid="status-popover-abs-1"/);
    expect(html).toMatch(/name="intent" value="set-status"/);
    expect(html).toMatch(/name="returnTo" value="\/admin\/submissions\/abs-1"/);
  });

  it("keeps all five assignable statuses as radios with the current one checked", () => {
    // Attribute-order-independent on purpose: React emits `checked=""` BETWEEN
    // `name` and `value` on the selected radio, so a regex that assumes
    // `name="status" value="pending"` adjacency passes for four statuses and
    // fails for whichever one happens to be current.
    for (const status of ["accepted", "accept_queue", "pending", "decline_queue", "declined"]) {
      expect(html).toMatch(new RegExp(`name="status"[^>]*value="${status}"`));
    }
    // The current status is the checked one, and only that one.
    expect(html).toMatch(/<input type="radio" name="status" checked=""[^>]*value="pending"/);
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it("keeps Cancel and Save", () => {
    expect(html).toMatch(/type="reset"/);
    expect(html).toMatch(/type="submit"/);
    expect(html).toMatch(/Save/);
    expect(html).toMatch(/Cancel/);
  });
});
