// The entry of `pnpm --silent eval:generation`, through the package script. cli.ts only exports main(), so the
// tests import it without running it (additions E).
import { main } from "./cli.ts";

process.exitCode = await main(process.argv.slice(2));
