import { describe, expect, it } from "vitest";
import { assertPublicWebUrl, assertSafeWebUrl, resolvePublicWebUrl } from "./web-search.js";

describe("web retrieval network boundary", () => {
  it("rejects file URLs and literal private hosts", () => {
    expect(() => assertSafeWebUrl("file:///etc/passwd")).toThrow("unsupported_url_protocol");
    expect(() => assertSafeWebUrl("http://127.0.0.1/private")).toThrow("private_network_url_denied");
  });

  it("rejects public-looking domains that resolve to a private address", async () => {
    await expect(assertPublicWebUrl(
      "https://example.test/resource",
      (async () => [{ address: "192.168.1.10", family: 4 }]) as any,
    )).rejects.toThrow("private_network_url_denied");
  });

  it("accepts a domain only when every resolved address is public", async () => {
    await expect(assertPublicWebUrl(
      "https://example.test/resource",
      (async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]) as any,
    )).resolves.toHaveProperty("hostname", "example.test");
  });

  it("pins the validated address for the eventual connection", async () => {
    await expect(resolvePublicWebUrl(
      "https://example.test/resource",
      (async () => [{ address: "93.184.216.34", family: 4 }]) as any,
    )).resolves.toMatchObject({
      address: "93.184.216.34",
      family: 4,
      url: expect.objectContaining({ hostname: "example.test" }),
    });
  });

  it("rejects private IPv4 ranges expressed as mapped IPv6 addresses", async () => {
    await expect(resolvePublicWebUrl(
      "https://example.test/resource",
      (async () => [{ address: "::ffff:172.16.0.8", family: 6 }]) as any,
    )).rejects.toThrow("private_network_url_denied");
  });
});
