import { describe, expect, it } from "vitest";
import {
  resolveConnectionProxyConfig,
  validateConnectionProxyUrl,
} from "../../src/lib/network/connectionProxy.js";

describe("connection proxy endpoint validation", () => {
  it("accepts standard proxy schemes and normalizes host:port input", () => {
    expect(validateConnectionProxyUrl("proxy.example.com:8080")).toBe("http://proxy.example.com:8080/");
    expect(validateConnectionProxyUrl("socks5://proxy.example.com:1080")).toBe("socks5://proxy.example.com:1080");
  });

  it("accepts only HTTP(S) relay URLs", () => {
    expect(validateConnectionProxyUrl("https://relay.example.com/forward", { relay: true }))
      .toBe("https://relay.example.com/forward");
    expect(validateConnectionProxyUrl("socks5://relay.example.com:1080", { relay: true })).toBe("");
  });

  it("rejects shell metacharacters and non-network schemes", () => {
    expect(validateConnectionProxyUrl("http://proxy.example.com:8080\nwhoami")).toBe("");
    expect(validateConnectionProxyUrl("file:///etc/passwd")).toBe("");
    expect(validateConnectionProxyUrl("javascript:alert(1)")).toBe("");
  });

  it("fails closed for an invalid legacy connection proxy", async () => {
    await expect(resolveConnectionProxyConfig({
      connectionProxyEnabled: true,
      connectionProxyUrl: "file:///etc/passwd",
    })).resolves.toEqual(expect.objectContaining({
      source: "none",
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
    }));
  });
});
