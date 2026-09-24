import { describe, expect, it } from "vitest";
import { formatPhone, formatPrice, formatTime, mailtoUrl, telUrl, weeklyHours } from "../src/format.ts";

describe("format", () => {
  it("formats a US phone number for display and for tel: links", () => {
    expect(formatPhone("+15125550142")).toBe("(512) 555-0142");
    expect(String(telUrl("+15125550142"))).toBe("tel:+15125550142");
  });

  it("builds a mailto link", () => {
    expect(String(mailtoUrl("office@example.com"))).toBe("mailto:office@example.com");
  });

  it("formats whole-dollar prices", () => {
    expect(formatPrice(89)).toBe("$89");
    expect(formatPrice(1250)).toBe("$1,250");
    expect(formatPrice(100000)).toBe("$100,000");
  });

  it.each([
    ["00:00", "12:00 AM"],
    ["08:00", "8:00 AM"],
    ["12:00", "12:00 PM"],
    ["13:30", "1:30 PM"],
    ["23:59", "11:59 PM"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatTime(input)).toBe(expected);
  });

  it("lists all seven days with Closed and Open 24 hours", () => {
    expect(
      weeklyHours([
        { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" },
        { days: ["Saturday"], opens: "00:00", closes: "23:59" },
      ]),
    ).toEqual([
      { day: "Monday", time: "8:00 AM – 5:00 PM" },
      { day: "Tuesday", time: "8:00 AM – 5:00 PM" },
      { day: "Wednesday", time: "8:00 AM – 5:00 PM" },
      { day: "Thursday", time: "8:00 AM – 5:00 PM" },
      { day: "Friday", time: "8:00 AM – 5:00 PM" },
      { day: "Saturday", time: "Open 24 hours" },
      { day: "Sunday", time: "Closed" },
    ]);
  });
});
