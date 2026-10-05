import { describe, expect, it } from "vitest";
import { looksLikeSpam, PROBLEM_TEXT, readLead } from "../src/lead.ts";

const fields = (values: Record<string, string>) => new URLSearchParams(values);

describe("readLead", () => {
  it("accepts the minimum: a name and a phone number", () => {
    expect(readLead(fields({ name: "Al", phone: "5125550199" }))).toEqual({
      ok: true,
      lead: { name: "Al", phone: "5125550199", email: null, service: null, message: null },
    });
  });

  it("trims every field and turns empty optional fields into null", () => {
    const result = readLead(fields({ name: "  Al  ", phone: " +1 (512) 555-0199 ", email: " ", service: "", message: "  " }));
    expect(result).toEqual({ ok: true, lead: { name: "Al", phone: "+1 (512) 555-0199", email: null, service: null, message: null } });
  });

  it.each([
    ["name", { name: "", phone: "5125550199" }],
    ["name", { name: "x".repeat(81), phone: "5125550199" }],
    ["phone", { name: "Al", phone: "" }],
    ["phone", { name: "Al", phone: "555-01" }],
    ["phone", { name: "Al", phone: "call me maybe 5125550199" }],
    ["phone", { name: "Al", phone: "(((((((((((" }],
    ["phone", { name: "Al", phone: "5".repeat(31) }],
    ["email", { name: "Al", phone: "5125550199", email: "not-an-email" }],
    ["email", { name: "Al", phone: "5125550199", email: `${"a".repeat(250)}@b.co` }],
    ["service", { name: "Al", phone: "5125550199", service: "s".repeat(61) }],
    ["message", { name: "Al", phone: "5125550199", message: "m".repeat(2001) }],
  ])("reports %s", (problem, values) => {
    expect(readLead(fields(values))).toEqual({ ok: false, problems: [problem] });
  });

  it("reports every problem at once, in field order", () => {
    expect(readLead(fields({}))).toEqual({ ok: false, problems: ["name", "phone"] });
  });

  it("counts a CRLF line break in the message as one character, as the browser's maxlength does", () => {
    const message = `${"m".repeat(999)}\r\n${"m".repeat(1000)}`;
    const result = readLead(fields({ name: "Al", phone: "5125550199", message }));
    expect(result.ok && result.lead.message?.length).toBe(2000);
  });

  it("removes control and invisible characters, keeping emoji joiners and message newlines", () => {
    const result = readLead(fields({ name: "Ana\u200B \u{1F469}\u200D\u{1F527}\u0000", phone: "512\u202E5550199", message: "a\r\nb\u0007" }));
    expect(result).toEqual({ ok: true, lead: { name: "Ana \u{1F469}\u200D\u{1F527}", phone: "5125550199", email: null, service: null, message: "a\nb" } });
  });

  // A15 minor 5: U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR (Zl, Zp) are neither Cc nor Cf, and
  // some mail clients break a subject line at them. QA-2 QS(2): they are line breaks, so they become one
  // (a space in a one-line field) instead of gluing the words on each side together.
  it("turns line and paragraph separators (U+2028, U+2029) into line breaks: a newline in the message, a space elsewhere", () => {
    const result = readLead(fields({ name: "Ana\u2028Bell", phone: "512\u20295550199", service: "Drain\u2029cleaning", message: "One\u2028two\u2029three\r\nfour" }));
    expect(result).toEqual({ ok: true, lead: { name: "Ana Bell", phone: "512 5550199", email: null, service: "Drain cleaning", message: "One\ntwo\nthree\nfour" } });
  });

  // An address split by a line break is not silently joined into another address: the visitor is asked to check it.
  it("asks the visitor to check an email address that a line break or tab splits", () => {
    for (const email of ["a\u2028@b.co", "a\t@b.co", "a\r\n@b.co"]) expect(readLead(fields({ name: "Al", phone: "5125550199", email }))).toEqual({ ok: false, problems: ["email"] });
  });

  // Header safety: the name goes into the lead email's subject, so no line break of any kind stays in a one-line field.
  it("keeps a single-line field on one line, with a space where the line broke", () => {
    const result = readLead(fields({ name: "Al\r\nBcc: victim", phone: "5125550199" }));
    expect(result.ok && result.lead.name).toBe("Al Bcc: victim");
    const breaks = readLead(fields({ name: "A\nB\rC\u000BD\fE\u2028F\u2029G\tH", phone: "512\n555\u000B0199", service: "S\r\nT" }));
    expect(breaks).toEqual({ ok: true, lead: { name: "A B C D E F G H", phone: "512 555 0199", email: null, service: "S T", message: null } });
  });

  // QA-2 QS(2): a tab, vertical tab or form feed arrives by paste (spreadsheets, emails, some editors);
  // the words on each side stay apart.
  it("turns a tab into a space, and a vertical tab or form feed into a newline in the message", () => {
    const result = readLead(fields({ name: "Pat\tSmith", phone: "5125550123", message: "Kitchen\tsink\tleaking\u000BUpstairs\u2029bath\fAttic" }));
    expect(result).toEqual({ ok: true, lead: { name: "Pat Smith", phone: "5125550123", email: null, service: null, message: "Kitchen sink leaking\nUpstairs\nbath\nAttic" } });
  });

  // U+0085 NEXT LINE is a line break too (UAX #14 class NL, which "acts like BK"). Deleted as a control
  // character, it glued the words on each side together.
  it("turns NEXT LINE (U+0085) into a line break: a newline in the message, a space elsewhere", () => {
    const result = readLead(fields({ name: "Pat\u0085Smith", phone: "512\u00855550199", service: "Drain\u0085cleaning", message: "Leak\u0085upstairs" }));
    expect(result).toEqual({ ok: true, lead: { name: "Pat Smith", phone: "512 5550199", email: null, service: "Drain cleaning", message: "Leak\nupstairs" } });
  });

  it("counts a vertical tab, form feed or line separator in the message as one character, like a newline", () => {
    for (const lineBreak of ["\u000B", "\f", "\u2028", "\u2029"]) {
      const result = readLead(fields({ name: "Al", phone: "5125550199", message: `${"m".repeat(999)}${lineBreak}${"m".repeat(1000)}` }));
      expect(result.ok && result.lead.message).toBe(`${"m".repeat(999)}\n${"m".repeat(1000)}`);
    }
  });
});

// QA-2 QS(1): a number copied from a web page or a contact card often holds typographic spaces and
// dashes (a no-break space, a non-breaking hyphen, an en dash). To the eye it is digits, spaces and
// dashes, which the message says are allowed, so each becomes an ASCII space or "-" before the phone
// rule is checked, and the lead stores that. The rule itself is unchanged.
describe("readLead phone: typographic spaces and dashes", () => {
  // Every Unicode space separator (General_Category Zs), and the dashes the ruling names.
  const SPACES = [0x0020, 0x00a0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x202f, 0x205f, 0x3000];
  const DASHES = [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d];
  const hex = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

  it("lists every space separator the runtime knows (Zs)", () => {
    const zs = /\p{Zs}/u;
    const found: number[] = [];
    for (let code = 0; code < 0x110000; code++) if ((code < 0xd800 || code > 0xdfff) && zs.test(String.fromCodePoint(code))) found.push(code);
    expect(found.map(hex)).toEqual(SPACES.map(hex));
  });

  it.each(SPACES.map((code) => [hex(code), code]))("accepts %s between the digits and stores an ASCII space", (_, code) => {
    const space = String.fromCodePoint(code);
    expect(readLead(fields({ name: "Al", phone: `(512)${space}555${space}0123` }))).toEqual({
      ok: true, lead: { name: "Al", phone: "(512) 555 0123", email: null, service: null, message: null },
    });
  });

  it.each(DASHES.map((code) => [hex(code), code]))("accepts %s between the digits and stores a hyphen", (_, code) => {
    const dash = String.fromCodePoint(code);
    expect(readLead(fields({ name: "Al", phone: `512${dash}555${dash}0123` }))).toEqual({
      ok: true, lead: { name: "Al", phone: "512-555-0123", email: null, service: null, message: null },
    });
  });

  it.each([
    ["a no-break space and a non-breaking hyphen", "(512)\u00a0555\u20110123", "(512) 555-0123"],
    ["en dashes", "512\u2013555\u20130123", "512-555-0123"],
    ["narrow no-break spaces", "+1\u202f512\u202f555\u202f0123", "+1 512 555 0123"],
    ["a no-break space at each end", "\u00a0512-555-0123\u00a0", "512-555-0123"],
  ])("accepts the QA's number with %s", (_, phone, stored) => {
    expect(readLead(fields({ name: "Al", phone }))).toEqual({ ok: true, lead: { name: "Al", phone: stored, email: null, service: null, message: null } });
  });

  it("still counts only ASCII digits and still refuses other characters", () => {
    for (const phone of ["\uff15\uff11\uff12\uff15\uff15\uff15\uff10\uff11\uff12\uff13", "512\u2016555\u20160123", "512\u2043555\u20430123", "\u2013\u2013\u2013\u2013\u2013\u2013\u2013"]) {
      expect(readLead(fields({ name: "Al", phone }))).toEqual({ ok: false, problems: ["phone"] });
    }
  });

  it("leaves typographic spaces and dashes in the other fields as they were typed", () => {
    const result = readLead(fields({ name: "Jean\u2011Luc\u00a0Picard", phone: "5125550123", message: "Leak \u2013 upstairs" }));
    expect(result).toEqual({ ok: true, lead: { name: "Jean\u2011Luc\u00a0Picard", phone: "5125550123", email: null, service: null, message: "Leak \u2013 upstairs" } });
  });
});

describe("looksLikeSpam", () => {
  const lead = (message: string | null) => ({ name: "n", phone: "5125550199", email: null, service: null, message });
  it("flags more than three http occurrences, case-insensitively", () => {
    expect(looksLikeSpam(lead("http://a HTTP://b https://c"))).toBe(false);
    expect(looksLikeSpam(lead("http://a HTTP://b https://c Http://d"))).toBe(true);
    expect(looksLikeSpam(lead(null))).toBe(false);
  });

  // S1 Part L: "www." and "://" start a link too, and one link is one count, however many of its parts are there.
  it("counts www. links: three are not spam, four are, in any case", () => {
    expect(looksLikeSpam(lead("www.a.com WWW.b.com Www.c.com"))).toBe(false);
    expect(looksLikeSpam(lead("www.a.com WWW.b.com Www.c.com wWw.d.com"))).toBe(true);
  });

  it("counts a bare :// link (ftp://x) once", () => {
    expect(looksLikeSpam(lead("ftp://a ftp://b sftp://c"))).toBe(false);
    expect(looksLikeSpam(lead("ftp://a ftp://b sftp://c ws://d"))).toBe(true);
  });

  it("counts https://www.x once: one link is one count", () => {
    expect(looksLikeSpam(lead("https://www.a https://www.b https://www.c HTTP://WWW.d"))).toBe(true);
    expect(looksLikeSpam(lead("https://www.a https://www.b https://www.c"))).toBe(false);
    expect(looksLikeSpam(lead("https://www.a https://www.b http://www.c"))).toBe(false);
  });

  it("counts mixed forms by link starts: each of http, www. and :// that is not part of the one before is a link", () => {
    expect(looksLikeSpam(lead("http://a www.b ftp://c"))).toBe(false);
    expect(looksLikeSpam(lead("http://a www.b ftp://c https://www.d"))).toBe(true);
    expect(looksLikeSpam(lead("see www.a, https://www.b and ftp://c"))).toBe(false);
    expect(looksLikeSpam(lead("http www.a ftp://b ://c"))).toBe(true);
  });
});

// S1 Part L: a name with an address, a link or no letter or digit gets the name's existing error, nothing new.
describe("readLead names (S1)", () => {
  const nameResult = (name: string) => readLead(fields({ name, phone: "5125550199" }));

  it.each(["Ann @ x", "ann@example.com", "@", "a://b", "http://x", "www.x", "WWW.X", "Www.Shop.com", "Visit www.x.com"])(
    "refuses the name %j with the existing name error",
    (name) => {
      expect(nameResult(name)).toEqual({ ok: false, problems: ["name"] });
    },
  );

  const BLANK = ["\u3164", "\u2800", "\uFFA0", "\u115F", "\u1160", "\u034F"];
  it.each(BLANK.map((c) => [c.codePointAt(0)?.toString(16), c] as const))("refuses a name of only U+%s, alone and with spaces", (_code, blank) => {
    for (const name of [blank, ` ${blank} `, `${blank} ${blank}`]) expect(nameResult(name)).toEqual({ ok: false, problems: ["name"] });
  });

  it("refuses a name of punctuation and symbols only", () => {
    for (const name of ["-", "...", "!!", "\u{1F600}"]) expect(nameResult(name)).toEqual({ ok: false, problems: ["name"] });
  });

  it.each(["Ann-Marie O'Neil", "José", "李雷", "Dana 2", "Mr. Smith", "7", "\u3164Al", "Al\u2800 B"])("keeps accepting the name %j", (name) => {
    expect(nameResult(name)).toEqual({ ok: true, lead: { name, phone: "5125550199", email: null, service: null, message: null } });
  });

  it("uses the name's existing words and adds none", () => {
    expect(PROBLEM_TEXT.name).toBe("Please enter your name (up to 80 characters).");
    expect(Object.keys(PROBLEM_TEXT)).toEqual(["name", "phone", "email", "service", "message"]);
  });
});

// Pins added after the brief (test-only). Each one goes red on a mutant that the tests above let through.
describe("readLead edges", () => {
  // A15 minor 2: the rule is unchanged; the message names what it allows, since "ext 4" or "/" was
  // refused with a message about digits.
  it.each(["512 555 0123 ext 4", "512-555-0123 x12", "512/555-0123"])("refuses %s with a message that names the allowed characters and the extension", (phone) => {
    expect(readLead(fields({ name: "Al", phone }))).toEqual({ ok: false, problems: ["phone"] });
    expect(PROBLEM_TEXT.phone).toBe(
      "Please enter a phone number we can call back, with at least 7 digits. Use only digits, spaces, dashes, dots, parentheses and a plus sign, and leave out any extension.",
    );
  });

  it("keeps an emoji joiner in the message too", () => {
    const mechanic = String.fromCodePoint(0x1f469, 0x200d, 0x1f527);
    const result = readLead(fields({ name: "Al", phone: "5125550199", message: `Ask for the ${mechanic}` }));
    expect(result.ok && result.lead.message).toBe(`Ask for the ${mechanic}`);
  });

  it("turns a lone CR line break in the message into a newline", () => {
    const result = readLead(fields({ name: "Al", phone: "5125550199", message: "a\rb" }));
    expect(result.ok && result.lead.message).toBe("a\nb");
  });
});
