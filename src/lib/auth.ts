import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { db } from "./db";

export type Plan = "trial" | "starter" | "pro" | "agency" | "enterprise";

export type User = {
  email: string;
  name: string;
  phone: string;
  passHash: string;
  plan: Plan;
  credits: number;
  trialEnds: string; // ISO
  createdAt: string; // ISO
  lang: "ar" | "en";
};

export const PLAN_CREDITS: Record<Plan, number> = { trial: 50, starter: 200, pro: 700, agency: 2000, enterprise: 10000 };
const SESSION_TTL = 60 * 60 * 24 * 30;
const COOKIE = "nashr_session";

export function normalizeEmail(e: string) {
  return e.trim().toLowerCase();
}

export function normalizePhone(p: string) {
  // Keep digits and leading +. Saudi numbers like 05xxxxxxxx become +9665xxxxxxxx.
  let d = p.replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (/^05\d{8}$/.test(d)) d = "+966" + d.slice(1);
  if (/^5\d{8}$/.test(d)) d = "+966" + d;
  if (!d.startsWith("+")) d = "+" + d;
  return d;
}

export async function getUser(email: string): Promise<User | null> {
  return db.get<User>(`user:${normalizeEmail(email)}`);
}

export async function saveUser(u: User) {
  await db.set(`user:${u.email}`, u);
  await db.sadd("users:all", u.email);
}

export async function createUser(input: { email: string; name: string; phone: string; password: string; lang: "ar" | "en" }): Promise<User> {
  const email = normalizeEmail(input.email);
  const now = new Date();
  const u: User = {
    email,
    name: input.name.trim().slice(0, 80),
    phone: normalizePhone(input.phone),
    passHash: await bcrypt.hash(input.password, 10),
    plan: "trial",
    credits: PLAN_CREDITS.trial,
    trialEnds: new Date(now.getTime() + 7 * 864e5).toISOString(),
    createdAt: now.toISOString(),
    lang: input.lang,
  };
  await saveUser(u);
  return u;
}

export async function verifyPassword(u: User, password: string) {
  return bcrypt.compare(password, u.passHash);
}

export async function createSession(email: string) {
  const token = randomBytes(32).toString("hex");
  await db.set(`session:${token}`, email, SESSION_TTL);
  const jar = await cookies();
  jar.set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await db.del(`session:${token}`);
  jar.delete(COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  const email = await db.get<string>(`session:${token}`);
  if (!email) return null;
  return getUser(email);
}

export function isAdmin(req: Request) {
  const key = process.env.WAITLIST_ADMIN_KEY;
  const url = new URL(req.url);
  const given = url.searchParams.get("key") ?? req.headers.get("x-admin-key");
  return Boolean(key && given === key);
}
