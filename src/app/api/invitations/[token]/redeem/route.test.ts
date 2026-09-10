import { describe, expect, it } from "vitest";
import { getClientIp } from "./route";

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/invitations/tok/redeem", {
    method: "POST",
    headers,
  });
}

describe("getClientIp", () => {
  it("returns a single IP as-is", () => {
    expect(getClientIp(requestWith({ "x-forwarded-for": "1.2.3.4" }))).toBe(
      "1.2.3.4",
    );
  });

  it("takes the leftmost (original client) entry from a chain", () => {
    expect(
      getClientIp(requestWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })),
    ).toBe("1.2.3.4");
  });

  it("skips a leading empty entry instead of returning it", () => {
    expect(getClientIp(requestWith({ "x-forwarded-for": ",1.2.3.4" }))).toBe(
      "1.2.3.4",
    );
  });

  it("skips a whitespace-only leading entry, trimming the real one", () => {
    expect(
      getClientIp(requestWith({ "x-forwarded-for": "   , 1.2.3.4" })),
    ).toBe("1.2.3.4");
  });

  it("falls back to \"unknown\" when every entry is empty", () => {
    expect(getClientIp(requestWith({ "x-forwarded-for": ",," }))).toBe(
      "unknown",
    );
  });

  it("falls back to \"unknown\" for an empty header value", () => {
    expect(getClientIp(requestWith({ "x-forwarded-for": "" }))).toBe(
      "unknown",
    );
  });

  it("falls back to \"unknown\" when the header is absent", () => {
    expect(getClientIp(requestWith({}))).toBe("unknown");
  });

  it("never returns an empty string, across all of the above", () => {
    for (const xff of ["1.2.3.4", "1.2.3.4, 5.6.7.8", ",1.2.3.4", "   , 1.2.3.4", ",,", ""]) {
      expect(getClientIp(requestWith({ "x-forwarded-for": xff }))).not.toBe("");
    }
    expect(getClientIp(requestWith({}))).not.toBe("");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent, and trims it", () => {
    expect(getClientIp(requestWith({ "x-real-ip": " 9.9.9.9 " }))).toBe(
      "9.9.9.9",
    );
  });

  it("does not accept a whitespace-only x-real-ip either", () => {
    expect(getClientIp(requestWith({ "x-real-ip": "   " }))).toBe("unknown");
  });

  it("prefers a valid x-forwarded-for entry over x-real-ip", () => {
    expect(
      getClientIp(
        requestWith({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "9.9.9.9" }),
      ),
    ).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when x-forwarded-for is entirely empty entries", () => {
    expect(
      getClientIp(
        requestWith({ "x-forwarded-for": ",,", "x-real-ip": "9.9.9.9" }),
      ),
    ).toBe("9.9.9.9");
  });
});
