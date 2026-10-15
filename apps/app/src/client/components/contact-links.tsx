import { isSafeUrl } from "@asksite/site-schema";

// Contact details a visitor or buyer typed (Messages, Orders), shown as links only when they are safe to follow.

/** A tel: or mailto: link only when it passes Plan 1's URL guard; otherwise plain text (§9.1). */
export function SafeLink({ href, text }: { href: string; text: string }) {
  return isSafeUrl(href, ["tel:", "mailto:"]) ? (
    <a href={href} className="link break-all">
      {text}
    </a>
  ) : (
    <span className="break-all">{text}</span>
  );
}

/** A tap-to-call link for a real phone number (7 or more digits), plain text for anything else. */
export function PhoneLink({ phone }: { phone: string }) {
  const dial = phone.replace(/[^0-9+]/g, "");
  return dial.replace(/\D/g, "").length >= 7 ? <SafeLink href={`tel:${dial}`} text={phone} /> : <span className="break-all">{phone}</span>;
}
