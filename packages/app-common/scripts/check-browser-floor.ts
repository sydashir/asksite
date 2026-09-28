import { main } from "./browser-floor/cli.ts";

// Usage: node check-browser-floor.ts <tsconfig.json>
// Checks that config's program against the owner client's browser floor (src/browser-floor.ts). Run
// `tsc -p <tsconfig.json>` first for readable type errors. Exit 0: nothing fails; 1: a use fails (or a
// `floor-ok` has no reason); 2: the program cannot be judged.
process.exitCode = main(process.argv.slice(2));
