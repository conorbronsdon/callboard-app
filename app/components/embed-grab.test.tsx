import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmbedGrabCard, EmbedGrabLink } from "./embed-grab";

describe("EmbedGrabLink", () => {
  it("MUST FIRE for schedule and MUST NOT FIRE for speakers", () => {
    const html = renderToStaticMarkup(
      <EmbedGrabLink widget="schedule">Embed the schedule</EmbedGrabLink>,
    );

    expect(html).toContain('href="/admin/embeds?w=schedule"');
    expect(html).toContain("Embed the schedule");
    expect(html).not.toContain("w=speakers");
  });

  it("MUST FIRE for speakers and MUST NOT FIRE for schedule", () => {
    const html = renderToStaticMarkup(
      <EmbedGrabLink widget="speakers">Embed the speaker directory</EmbedGrabLink>,
    );

    expect(html).toContain('href="/admin/embeds?w=speakers"');
    expect(html).toContain("Embed the speaker directory");
    expect(html).not.toContain("w=schedule");
  });
});

describe("EmbedGrabCard", () => {
  it("MUST FIRE for its intended destinations and MUST NOT FIRE for other widgets", () => {
    const html = renderToStaticMarkup(<EmbedGrabCard />);

    expect(html.match(/href="\/admin\/embeds\?w=schedule"/g)).toHaveLength(1);
    expect(html.match(/href="\/admin\/embeds\?w=speakers"/g)).toHaveLength(1);
    expect(html.match(/href="\/admin\/embeds"/g)).toHaveLength(1);
    expect(html).not.toContain("w=agenda");
    expect(html).not.toContain("w=gallery");
  });
});
