import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import {
  defaultAuthURL,
  fetchBag,
  normalizeAuthURL,
} from "../../src/apple/bag";

describe("apple/bag", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses authenticateAccount from urlBag", async () => {
    const xml = buildPlist({
      urlBag: {
        authenticateAccount:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(
      'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/',
    );
  });

  it("normalizes a native auth endpoint at the plist root to the /fast/ path", async () => {
    const xml = buildPlist({
      authenticateAccount: "https://auth.itunes.apple.com/auth/v1/native",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(
      "https://auth.itunes.apple.com/auth/v1/native/fast/",
    );
  });

  it("falls back when authenticateAccount is missing", async () => {
    const xml = buildPlist({
      urlBag: {
        Ghostrider: "YES",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(defaultAuthURL);
  });

  it("falls back when bag proxy returns non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => ({ error: "upstream failed" }),
      }),
    );

    const result = await fetchBag("aabbccddeeff");

    expect(result.authURL).toBe(defaultAuthURL);
  });

  describe("normalizeAuthURL", () => {
    it("appends /fast/ to a bare native auth endpoint", () => {
      expect(
        normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native"),
      ).toBe("https://auth.itunes.apple.com/auth/v1/native/fast/");
    });

    it("adds the trailing slash when /fast is already present", () => {
      expect(
        normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native/fast"),
      ).toBe("https://auth.itunes.apple.com/auth/v1/native/fast/");
    });

    it("is idempotent on an already-normalized endpoint", () => {
      expect(
        normalizeAuthURL("https://auth.itunes.apple.com/auth/v1/native/fast/"),
      ).toBe("https://auth.itunes.apple.com/auth/v1/native/fast/");
    });

    it('为旧版认证端点补齐尾部斜杠', () => {
      const legacy =
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate";
      expect(normalizeAuthURL(legacy)).toBe(`${legacy}/`);
    });

    it('保留 pod 主机和路由参数，且不会重复添加斜杠', () => {
      const bare = 'https://p7-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?Pod=7&PRH=7&guid=abc';
      const expected = 'https://p7-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/?Pod=7&PRH=7&guid=abc';
      expect(normalizeAuthURL(bare)).toBe(expected);
      expect(normalizeAuthURL(expected)).toBe(expected);
    });

    it.each([
      'https://example.com/WebObjects/MZFinance.woa/wa/authenticate',
      'https://buy.itunes.apple.com.evil.example/WebObjects/MZFinance.woa/wa/authenticate',
      'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct',
    ])('不改写其他主机或非认证路径：%s', (url) => {
      expect(normalizeAuthURL(url)).toBe(url);
    });
  });
});
