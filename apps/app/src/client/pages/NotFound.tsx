import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";

export function NotFound() {
  const heading = usePageHeading<HTMLHeadingElement>("Page not found");
  return (
    <section className="card mx-auto max-w-xl">
      <h1 ref={heading} tabIndex={-1} className="page-title">
        Page not found
      </h1>
      <p className="mt-3">
        <a href="/" className="link" onClick={onLinkClick}>
          Go to your websites
        </a>
      </p>
    </section>
  );
}
