import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";

export function NotFound() {
  const heading = usePageHeading<HTMLHeadingElement>("Page not found", "Admin");
  return (
    <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
      Page not found
    </h1>
  );
}
