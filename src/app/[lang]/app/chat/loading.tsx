import RouteLoading from "@/components/app/RouteLoading";

/** Shown while the server renders this screen (rule 1115); the sidebar stays. */
export default function Loading() {
  return <RouteLoading kind="chat" />;
}
