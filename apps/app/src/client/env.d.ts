/// <reference types="vite/client" />

/** The product domain, fixed at build time from the Worker's config (vite.config.ts). */
declare const __ROOT_DOMAIN__: string;
/** Where owners write with questions (decision 33), fixed at build time from the Worker's config. */
declare const __SUPPORT_EMAIL__: string;
/** The Turnstile sitekey, fixed at build time from the Worker's config (empty until Task 27 sets the real one). */
declare const __TURNSTILE_SITE_KEY__: string;
