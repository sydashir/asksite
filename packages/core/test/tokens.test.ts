import { describe, expect, it } from "vitest";
import { canonicalJson, hashIp, ipRateKey, isId, newId, newToken, sha256Hex, TOKEN_PATTERN } from "../src/index.ts";

describe("ids", () => {
  it("creates v4 UUIDs that isId accepts", () => {
    const id = newId();
    expect(isId(id)).toBe(true);
    expect(newId()).not.toBe(id);
  });

  it.each(["", "not-an-id", "7C9E6679-7425-40DE-944B-E07FC1F90AE7", "7c9e6679-7425-10de-944b-e07fc1f90ae7", "7c9e6679742540de944be07fc1f90ae7", "../7c9e6679-7425-40de-944b-e07fc1f90ae7"])(
    "isId rejects %j",
    (value) => {
      expect(isId(value)).toBe(false);
    },
  );
});

describe("tokens", () => {
  it("newToken is 43 base64url characters and never repeats", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(TOKEN_PATTERN);
  });

  it("sha256Hex matches the FIPS 180-2 test vector and hashes UTF-8", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("é")).toBe(await sha256Hex("é"));
    expect(await sha256Hex("é")).not.toBe(await sha256Hex("é"));
  });

  it("hashIp is a keyed, 22-character base64url hash", async () => {
    const a = await hashIp("key-one", "203.0.113.7");
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await hashIp("key-one", "203.0.113.7")).toBe(a);
    expect(await hashIp("key-two", "203.0.113.7")).not.toBe(a);
    expect(await hashIp("key-one", "203.0.113.8")).not.toBe(a);
    expect(a).not.toContain("203");
  });

  it("hashIp refuses an empty key instead of hashing without a secret", async () => {
    await expect(hashIp("", "203.0.113.7")).rejects.toThrow("non-empty key");
  });
});

describe("ipRateKey", () => {
  it("keeps an IPv4 address whole", () => {
    expect(ipRateKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("cuts an IPv6 address to its /64 network, whatever the notation", () => {
    const network = "2001:db8:85a3:0::/64";
    expect(ipRateKey("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(network);
    expect(ipRateKey("2001:DB8:85A3::8A2E:370:7334")).toBe(network);
    expect(ipRateKey("2001:db8:85a3::1")).toBe(network);
    expect(ipRateKey("2001:db8:85a3:1::1")).toBe("2001:db8:85a3:1::/64");
    expect(ipRateKey("::1")).toBe("0:0:0:0::/64");
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("gives equal strings for equal values in any key order", () => {
    expect(canonicalJson({ x: 1, y: [1, 2] })).toBe(canonicalJson({ y: [1, 2], x: 1 }));
  });

  it("drops undefined values like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });

  it("keeps a __proto__ key as data", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe('{"__proto__":{"x":1},"a":2}');
  });
});
