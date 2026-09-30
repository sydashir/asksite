import { CopyEdits as CopyEditsSchema, type CurrentAi, type OwnerEdits } from "@asksite/core";

type CopyEdits = OwnerEdits["copy"];

/**
 * The edits to change when the owner changes wording or order. Edits made against an older AI
 * draft no longer apply (§2.8 composeDocument), so the first change on a newer draft starts from
 * empty copy and order edits; hidden sections and the look carry over.
 */
export function editsForAi(ai: CurrentAi, edits: OwnerEdits): OwnerEdits {
  return edits.baseGenerationId === ai.generationId ? edits : { ...edits, baseGenerationId: ai.generationId, copy: {}, order: null };
}

export function withCopy(ai: CurrentAi, edits: OwnerEdits, change: (copy: CopyEdits) => CopyEdits): OwnerEdits {
  const base = editsForAi(ai, edits);
  return { ...base, copy: change(base.copy) };
}

/**
 * Whether OwnerEdits accepts this service name as a description key. Asked of core's own schema (never a copy of its
 * limit, so the length measure cannot drift): the empty string is always valid text (EditText, draft.ts), so only the key decides.
 */
const isAllowedKey = (key: string): boolean => CopyEditsSchema.safeParse({ serviceDescriptions: { [key]: "" } }).success;

/**
 * Sets the owner's description of one service. `services` are the current (trimmed) service names, the
 * keys composeDocument looks up: every write drops the keys of renamed or removed services, so stale keys
 * never count toward OwnerEdits' limit of 12 descriptions, one per service Facts allows (A8c-2).
 * It never emits a key OwnerEdits refuses (a name too long for the key schema): such a key is dropped, and a
 * description for such a name is not stored, because one refused key would fail every later autosave.
 */
export function withServiceDescription(copy: CopyEdits, services: readonly string[], name: string, text: string): CopyEdits {
  const kept = Object.entries(copy.serviceDescriptions ?? {}).filter(([key]) => key !== name && services.includes(key) && isAllowedKey(key));
  const written: Array<[string, string]> = isAllowedKey(name) ? [[name, text]] : [];
  return { ...copy, serviceDescriptions: Object.fromEntries([...kept, ...written]) };
}
