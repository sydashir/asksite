import { noteLog } from "@asksite/app-common";
import type { Context } from "hono";
import type { NoteStoredInvalid, StoredPart } from "../site-view.ts";

/**
 * The route's NoteStoredInvalid: the request's one log line (P4-3), which names the route, gets event
 * stored_json_invalid and every part read leniently so far, in the order they were read (P4-15 g). It sits with
 * the routes that use it, so the view module needs no Hono (P4-15 follow-up m1).
 */
export function storedJsonNote(c: Context): NoteStoredInvalid {
  const parts: StoredPart[] = [];
  return (part) => {
    parts.push(part);
    noteLog(c, { event: "stored_json_invalid", part: parts.join(",") });
  };
}
