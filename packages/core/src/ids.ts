/** Every record id is a random v4 UUID. */
export const newId = (): string => crypto.randomUUID();

/** True for a lower-case v4 UUID, the only id shape we ever create. */
export const isId = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
