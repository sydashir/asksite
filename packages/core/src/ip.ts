/**
 * The part of a client IP address that a rate limit is keyed on. An IPv4 address is used whole, and
 * an IPv4-mapped IPv6 address (::ffff:a.b.c.d, RFC 4291 §2.5.5.2) is keyed as that same a.b.c.d. Any
 * other IPv6 address is cut to its /64 network: one customer usually holds a whole /64, so a limit
 * keyed on the full address could be dodged by changing the last 64 bits. Input is CF-Connecting-IP
 * (one address).
 */
export function ipRateKey(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(":")) return address;
  const halves = address.split("::");
  if (halves.length > 2) return address; // not an IPv6 address: keep it whole
  const head = groupsOf(halves[0]);
  const tail = groupsOf(halves[1]);
  const zeros = halves.length === 2 ? Array.from({ length: Math.max(0, 8 - head.length - tail.length) }, () => "0") : [];
  const groups = [...head, ...zeros, ...tail].map((group) => group.replace(/^0+(?=.)/, ""));
  const [, high, low] = IPV4_MAPPED.exec(groups.join(":")) ?? [];
  if (high !== undefined && low !== undefined) return [high, low].flatMap((group) => bytesOf(parseInt(group, 16))).join(".");
  return `${groups.slice(0, 4).join(":")}::/64`;
}

// ::ffff:0:0/96 once "::" is expanded and leading zeros are dropped; captures the two IPv4 groups.
const IPV4_MAPPED = /^0:0:0:0:0:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const DOTTED_QUAD = /^\d{1,3}(\.\d{1,3}){3}$/;

/** One side of "::" as groups. An embedded dotted quad (a.b.c.d) is the two 16-bit groups it stands for. */
function groupsOf(side: string | undefined): string[] {
  if (side === undefined || side === "") return [];
  return side.split(":").flatMap((part) => {
    const octets = part.split(".").map(Number);
    if (!DOTTED_QUAD.test(part) || octets.some((octet) => octet > 255)) return [part];
    const value = octets.reduce((sum, octet) => sum * 256 + octet, 0);
    return [Math.floor(value / 0x10000).toString(16), (value % 0x10000).toString(16)];
  });
}

const bytesOf = (group: number): number[] => [group >> 8, group & 0xff];
