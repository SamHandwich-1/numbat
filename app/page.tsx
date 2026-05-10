import type { Route } from "next";
import { redirect } from "next/navigation";

export default function RootPage(): never {
  // Cast to Route until `/sessions` exists (step 12). With typedRoutes
  // enabled, Next emits a literal union of known routes into
  // .next/types/routes.d.ts and rejects unknown strings. The cast
  // becomes redundant — and removable — once the route lands.
  redirect("/sessions" as Route);
}
