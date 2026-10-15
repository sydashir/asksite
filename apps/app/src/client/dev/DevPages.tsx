import { NotFound } from "../pages/NotFound.tsx";
import { DevInbox } from "./DevInbox.tsx";
import { DevShop } from "./DevShop.tsx";
import { DevStart } from "./DevStart.tsx";

/** The development-only pages, reached from the notFound route (App.tsx). */
export default function DevPages() {
  if (location.pathname === "/dev") return <DevStart />;
  if (location.pathname === "/dev/inbox") return <DevInbox />;
  if (location.pathname === "/dev/shop") return <DevShop />;
  return <NotFound />;
}
