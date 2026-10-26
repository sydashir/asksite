import { describe, expect, it } from "vitest";
import { ipDailyKey, ipRateKey } from "../src/ip.ts";

// The shop's daily per-network cap (pages lane proposal 1.6, review I3) keys on the IPv6 /48, so one attacker's /48
// (65,536 /64s) counts once; the burst limit keeps ipRateKey's /64. An IPv4 address is used whole by both.
describe("ipDailyKey", () => {
  it("cuts an IPv6 address to its /48", () => {
    expect(ipDailyKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd::/48");
    expect(ipDailyKey("2001:db8:abcd:ffff::1")).toBe("2001:db8:abcd::/48");
    expect(ipDailyKey("2001:0db8:00ab::")).toBe("2001:db8:ab::/48");
  });

  it("gives every /64 of one /48 the same key, and another /48 another", () => {
    expect(ipDailyKey("2001:db8:abcd:1::9")).toBe(ipDailyKey("2001:db8:abcd:ffff::9"));
    expect(ipDailyKey("2001:db8:abce:1::9")).not.toBe(ipDailyKey("2001:db8:abcd:1::9"));
  });

  it("uses an IPv4 address (and an IPv4-mapped IPv6 address) whole, as ipRateKey does", () => {
    expect(ipDailyKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipDailyKey("::ffff:203.0.113.9")).toBe(ipRateKey("::ffff:203.0.113.9"));
    expect(ipDailyKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("keeps an address it cannot read whole", () => {
    expect(ipDailyKey("unknown")).toBe("unknown");
    expect(ipDailyKey("1::2::3")).toBe("1::2::3");
  });
});
