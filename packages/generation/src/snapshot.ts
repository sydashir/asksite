import { Brief, type GenerationInputSnapshot } from "@asksite/core";
import { Facts } from "@asksite/site-schema";
import { z } from "zod";

const Snapshot = z.strictObject({ facts: Facts, brief: Brief });

/** Re-validates generations.input_json (parsing parsed facts and brief is a no-op); null when it is not valid. */
export function parseSnapshot(inputJson: string): GenerationInputSnapshot | null {
  try {
    const result = Snapshot.safeParse(JSON.parse(inputJson));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
