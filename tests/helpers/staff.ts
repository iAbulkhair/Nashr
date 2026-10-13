import { saveStaff, type Staff } from "@/lib/staff";

let n = 0;
/** A fresh staff address, never a customer's. */
export const staffAddress = (p = "staff") => `${p}${++n}-${Math.random().toString(36).slice(2, 8)}@staff.example`;
/** A staff record written straight to the store (no setup code, no password unless given). */
export async function makeStaff(over: Partial<Staff> = {}): Promise<Staff> {
  const s: Staff = { email: staffAddress(), name: "Staff", role: "owner", passHash: "", createdAt: new Date().toISOString(), createdBy: "key", ...over };
  await saveStaff(s);
  return s;
}
