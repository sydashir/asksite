// Compiles every page stylesheet with the Tailwind CLI, minified: styles/sheets/<name>.css ->
// styles/out/<name>.css (gitignored). "baseline" is today's sheet; a design with its own
// styles/sheets/<id>.css gets its own sheet (A12). Run by `pnpm build:css`.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tailwind = fileURLToPath(new URL("../node_modules/.bin/tailwindcss", import.meta.url));
const sheets = readdirSync(new URL("../styles/sheets/", import.meta.url))
  .filter((file) => file.endsWith(".css"))
  .sort();
if (!sheets.includes("baseline.css")) throw new Error("styles/sheets/baseline.css is missing");

mkdirSync(new URL("../styles/out/", import.meta.url), { recursive: true });
for (const sheet of sheets) {
  execFileSync(tailwind, ["-i", `styles/sheets/${sheet}`, "-o", `styles/out/${sheet}`, "--minify"], { cwd: root, stdio: "inherit" });
}
