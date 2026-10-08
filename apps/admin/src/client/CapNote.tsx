/** A list the server cuts off at `cap` rows says so, so an admin never mistakes a full list for the whole history. */
export function CapNote({ count, cap, order = "most recent" }: { count: number; cap: number; order?: "most recent" | "oldest" }) {
  return count >= cap ? <p className="mt-2 text-sm text-slate-700">{order === "oldest" ? `Showing the ${cap} oldest waiting. Review these to see the rest.` : `Showing the ${cap} ${order}.`}</p> : null;
}
