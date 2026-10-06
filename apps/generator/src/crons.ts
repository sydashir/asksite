/**
 * The daily cron (wrangler.jsonc triggers.crons) that trims old generation inputs; any other cron string runs the sweeper.
 * Its own module, not an export of the Worker's entry point: workerd refuses a non-handler export there. config.test.ts
 * asserts wrangler.jsonc holds this string.
 */
export const TRIM_CRON = "17 3 * * *";
