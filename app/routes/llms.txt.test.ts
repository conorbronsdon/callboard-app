import { describe, expect, it } from "vitest";

import { loader } from "./llms.txt";

describe("GET /llms.txt", () => {
  it("MUST FIRE: serves plain text, 200, mentioning /demo", async () => {
    const response = await loader();
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(body).toContain("/demo");
  });
});
