/**
 * The part of a client IP address that a rate limit is keyed on. An IPv4 address is used whole. An
 * IPv6 address is cut to its /64 network: one customer usually holds a whole /64, so a limit keyed on
 * the full address could be dodged by changing the last 64 bits. Input is CF-Connecting-IP (one address).
 */
export function ipRateKey(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(":")) return address;
  const halves = address.split("::");
  if (halves.length > 2) return address; // not an IPv6 address: keep it whole
  const head = halves[0] === "" || halves[0] === undefined ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" && halves[1] !== undefined ? halves[1].split(":") : [];
  const zeros = halves.length === 2 ? Array.from({ length: Math.max(0, 8 - head.length - tail.length) }, () => "0") : [];
  const network = [...head, ...zeros, ...tail].slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ""));
  return `${network.join(":")}::/64`;
}
