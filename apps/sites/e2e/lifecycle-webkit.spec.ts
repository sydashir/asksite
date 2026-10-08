import { test } from "@playwright/test";
import { LIFECYCLE_USE } from "./lifecycle.ts";
import { lifecycleTests } from "./lifecycle-tests.ts";

// The lifecycle tests in webkit, alone after every other test (the "lifecycle" project, playwright.config.ts).
test.use(LIFECYCLE_USE.webkit);
lifecycleTests("webkit");
