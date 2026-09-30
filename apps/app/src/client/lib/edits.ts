import type { CurrentAi, OwnerEdits } from "@asksite/core";

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
 * Sets the owner's description of one service. `services` are the current (trimmed) service names, the
 * keys composeDocument looks up: every write drops the keys of renamed or removed services, so stale keys
 * never count toward OwnerEdits' limit of 12 descriptions, one per service Facts allows (A8c-2).
 */
export function withServiceDescription(copy: CopyEdits, services: readonly string[], name: string, text: string): CopyEdits {
  const kept = Object.entries(copy.serviceDescriptions ?? {}).filter(([key]) => key !== name && services.includes(key));
  return { ...copy, serviceDescriptions: Object.fromEntries([...kept, [name, text]]) };
}
