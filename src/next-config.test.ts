import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { modifyRouteRegex } from "next/dist/lib/redirect-status";

import nextConfig from "../next.config";

// Resolves the Cache-Control values our `headers()` rules apply to a
// pathname, matching `source` the same way Next's router does
// (strict path-match + modifyRouteRegex, see filesystem.js
// buildCustomRoute). Next does not override a Cache-Control set here,
// so this is the value the browser / edge actually receives.
async function cacheControlFor(pathname: string): Promise<string[]> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const values: string[] = [];
  for (const rule of rules) {
    const match = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex: string) => modifyRouteRegex(regex),
    });
    if (!match(pathname)) continue;
    for (const h of rule.headers) {
      if (h.key.toLowerCase() === "cache-control") values.push(h.value);
    }
  }
  return values;
}

const PAGE_POLICY = "private, no-cache, no-store, max-age=0, must-revalidate";

describe("next.config headers — Cache-Control", () => {
  it.each(["/", "/login", "/inbox", "/flows/abc/runs", "/dashboard"])(
    "page %s is private/no-store (never shared-cacheable)",
    async (pathname) => {
      expect(await cacheControlFor(pathname)).toEqual([PAGE_POLICY]);
    },
  );

  it("no rule marks any page as public / s-maxage", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const rule of rules) {
      for (const h of rule.headers) {
        if (h.key.toLowerCase() !== "cache-control") continue;
        expect(h.value).not.toMatch(/public|s-maxage|stale-while-revalidate/);
      }
    }
  });

  it.each(["/api/flows", "/api/whatsapp/webhook"])(
    "%s keeps only the /api no-store rule, not the page rule",
    async (pathname) => {
      expect(await cacheControlFor(pathname)).toEqual(["no-store"]);
    },
  );

  it.each([
    "/_next/static/chunks/main-abc123.js",
    "/_next/static/css/827658ac991ae42e.css",
    "/_next/image",
  ])("%s gets no Cache-Control from us (Next's native policy)", async (pathname) => {
    expect(await cacheControlFor(pathname)).toEqual([]);
  });
});
