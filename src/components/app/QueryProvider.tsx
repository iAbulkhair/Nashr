"use client";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createQueryClient } from "@/lib/rpc/query-client";

/**
 * The query cache for the screens that read through the better-auth hooks or oRPC (rules 3420, 3424). Mounted only by a
 * screen that uses it and only while AUTH_ENGINE is on, so with the switch off no page carries it. One client per mount
 * (`useState`), never a module-level one: a server render must not share a cache between two people's requests.
 */
export default function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
