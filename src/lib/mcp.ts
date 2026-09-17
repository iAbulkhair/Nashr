import { randomBytes } from "crypto";
import { db } from "./db";
import { getUser, type User } from "./auth";

/** Personal MCP tokens: `Authorization: Bearer nashr_...` → user. */
export async function createMcpToken(email: string) {
  const token = "nashr_" + randomBytes(24).toString("base64url");
  await db.set(`mcptoken:${token}`, email);
  await db.set(`mcptoken-of:${email}`, token);
  return token;
}
export async function getMcpToken(email: string) {
  return db.get<string>(`mcptoken-of:${email}`);
}
export async function revokeMcpToken(email: string) {
  const t = await getMcpToken(email);
  if (t) await db.del(`mcptoken:${t}`);
  await db.del(`mcptoken-of:${email}`);
}
export async function userFromBearer(req: Request): Promise<User | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(nashr_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const email = await db.get<string>(`mcptoken:${m[1]}`);
  return email ? getUser(email) : null;
}
