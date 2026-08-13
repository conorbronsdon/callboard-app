/**
 * The speaker chip carries a link ONLY when it is given an event slug. That is
 * the whole gate: the public schedule passes one and every name becomes a way
 * into that speaker's profile; the embed widgets render the same leaf without a
 * slug and stay plain text, because an iframe on a third-party page is the wrong
 * place to navigate the host document to a Callboard route.
 *
 * So the carve-out is tested in BOTH directions — the link must fire with a
 * slug, and must NOT fire without one — or a later change that made the embed
 * link too would pass unnoticed.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicSpeakerList } from "~/components/schedule-list";
import type { PublicSpeaker } from "~/lib/agenda/public-schedule";

const speakers: PublicSpeaker[] = [
  { personId: "pe-1", name: "Ada Lovelace", title: "Engineer", company: "Analytical" },
  { personId: "pe-2", name: "Grace Hopper", title: null, company: null },
];

describe("PublicSpeakerList speaker chips", () => {
  it("MUST FIRE: with an event slug, each chip is an anchor to that speaker's profile", () => {
    const html = renderToStaticMarkup(
      <PublicSpeakerList sessionId="s1" speakers={speakers} eventSlug="my-conf" />,
    );
    expect(html).toContain('href="/e/my-conf/speakers/pe-1"');
    expect(html).toContain('href="/e/my-conf/speakers/pe-2"');
    // The name still carries its selector, now inside the anchor.
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("data-speaker-name");
    expect((html.match(/<a /g) ?? []).length).toBe(2);
  });

  it("MUST NOT FIRE: without a slug (the embed path) the chips are plain, no anchor", () => {
    const html = renderToStaticMarkup(
      <PublicSpeakerList sessionId="s1" speakers={speakers} />,
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("/speakers/");
    // Same content and selectors, just not linked.
    expect(html).toContain("data-session-speaker");
    expect(html).toContain("Ada Lovelace");
  });
});
