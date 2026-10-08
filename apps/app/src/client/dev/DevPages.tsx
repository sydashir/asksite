import { NotFound } from "../pages/NotFound.tsx";
import { DevInbox } from "./DevInbox.tsx";
import { DevStart } from "./DevStart.tsx";

/** The development-only pages, reached from the notFound route (App.tsx). */
export default function DevPages() {
  if (location.pathname === "/dev") return <DevStart />;
  if (location.pathname === "/dev/inbox") return <DevInbox />;
  return <NotFound />;
}
