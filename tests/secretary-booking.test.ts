import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCalcom, parseCalendly, verifyCalcomSignature, verifyCalendlySignature, type Parsed } from "@/lib/secretary-booking";

const fx = (name: string): Record<string, unknown> => JSON.parse(readFileSync(`tests/fixtures/${name}.json`, "utf8"));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const hex = (key: string, data: string) => createHmac("sha256", key).update(data).digest("hex");

describe("booking signatures and parsers (rules 586-588)", () => {
  const KEY = "k".repeat(64);
  const BODY = JSON.stringify(fx("booking-calcom-created"));

  it("rule 586: Cal.com signature verifies a body and fails a changed body, a wrong key, a missing header and a header of the wrong length", () => {
    const sig = hex(KEY, BODY);
    expect(verifyCalcomSignature(BODY, sig, KEY)).toBe(true);
    expect(verifyCalcomSignature(BODY, sig.toUpperCase(), KEY)).toBe(true);
    expect(verifyCalcomSignature(BODY + " ", sig, KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, sig, "j".repeat(64))).toBe(false);
    expect(verifyCalcomSignature(BODY, null, KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, undefined, KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, "", KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, sig.slice(0, 62), KEY)).toBe(false);
    expect(verifyCalcomSignature(BODY, sig + "0", KEY)).toBe(false);
    // an empty key never verifies, even against the HMAC made with an empty key
    expect(verifyCalcomSignature(BODY, hex("", BODY), "")).toBe(false);
  });

  it("rule 587: Calendly signature verifies; fails on a stale timestamp (301 s), a future one, a wrong v1, a missing t, and an altered body", () => {
    const now = 1_790_000_000_000;
    const t = Math.floor(now / 1000);
    const header = (ts: number, body = BODY, key = KEY) => `t=${ts},v1=${hex(key, `${ts}.${body}`)}`;
    expect(verifyCalendlySignature(BODY, header(t), KEY, now)).toBe(true);
    expect(verifyCalendlySignature(BODY, header(t - 300), KEY, now)).toBe(true);
    expect(verifyCalendlySignature(BODY, header(t + 300), KEY, now)).toBe(true);
    expect(verifyCalendlySignature(BODY, header(t - 301), KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, header(t + 301), KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, header(t, BODY, "j".repeat(64)), KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, `t=${t},v1=${"0".repeat(64)}`, KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, `v1=${hex(KEY, `${t}.${BODY}`)}`, KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, `t=${t}`, KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY + " ", header(t), KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, null, KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, "", KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, "t=abc,v1=zz", KEY, now)).toBe(false);
    expect(verifyCalendlySignature(BODY, header(t), "", now)).toBe(false);
    // the timestamp is signed: a fresh t with the signature of an old one fails
    expect(verifyCalendlySignature(BODY, `t=${t},v1=${hex(KEY, `${t - 400}.${BODY}`)}`, KEY, now)).toBe(false);
    // unknown parts are ignored, order does not matter, the v1 may come first
    expect(verifyCalendlySignature(BODY, `v0=abc, v1=${hex(KEY, `${t}.${BODY}`)} ,t=${t},x=1`, KEY, now)).toBe(true);
  });

  const IGNORE = { kind: "ignore", externalId: "", name: "", eventName: "", start: "", end: "" } as const;

  it("rule 588: parsers map each fixture to the expected Parsed; an unknown event is ignore; missing fields are ignore, never a throw; a Calendly cancel flagged as a reschedule is ignore; a Calendly create naming an old invitee carries oldExternalId; every string is bounded", () => {
    const calcom = {
      created: { kind: "create", externalId: "bk_uid_aaaaaaaaaaaaaaaa", name: "Omar Example", eventName: "Intro call", start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T09:30:00.000Z" },
      cancelled: { kind: "cancel", externalId: "bk_uid_aaaaaaaaaaaaaaaa", name: "Omar Example", eventName: "Intro call", start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T09:30:00.000Z" },
      rescheduled: { kind: "move", externalId: "bk_uid_bbbbbbbbbbbbbbbb", oldExternalId: "bk_uid_aaaaaaaaaaaaaaaa", name: "Omar Example", eventName: "Intro call", start: "2026-10-14T10:00:00.000Z", end: "2026-10-14T10:30:00.000Z" },
    } satisfies Record<string, Parsed>;
    expect(parseCalcom(fx("booking-calcom-created"))).toEqual(calcom.created);
    expect(parseCalcom(fx("booking-calcom-cancelled"))).toEqual(calcom.cancelled);
    expect(parseCalcom(fx("booking-calcom-rescheduled"))).toEqual(calcom.rescheduled);

    const I1 = "https://api.calendly.com/scheduled_events/EXAMPLEEVENT0001/invitees/EXAMPLEINVITEE01";
    const I2 = "https://api.calendly.com/scheduled_events/EXAMPLEEVENT0002/invitees/EXAMPLEINVITEE02";
    expect(parseCalendly(fx("booking-calendly-created"))).toEqual({ kind: "create", externalId: I1, name: "Omar Example", eventName: "Intro call", start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T09:30:00.000Z" });
    expect(parseCalendly(fx("booking-calendly-canceled"))).toEqual({ kind: "cancel", externalId: I1, name: "Omar Example", eventName: "Intro call", start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T09:30:00.000Z" });
    // the create that names the old invitee: the move, carrying the old id
    expect(parseCalendly(fx("booking-calendly-created-rescheduled"))).toEqual({ kind: "move", externalId: I2, oldExternalId: I1, name: "Omar Example", eventName: "Intro call", start: "2026-10-14T10:00:00.000Z", end: "2026-10-14T10:30:00.000Z" });
    // the cancel that comes with it says it is a reschedule: nothing to do, the create owns the move
    expect(parseCalendly(fx("booking-calendly-canceled-rescheduled"))).toEqual(IGNORE);

    // the neutral shape never carries an email, a phone, a note, a link or a reason
    for (const f of ["booking-calcom-created", "booking-calcom-cancelled", "booking-calcom-rescheduled"]) {
      expect(JSON.stringify(parseCalcom(fx(f)))).not.toMatch(/@|\+1000|Private|video|http|Sara/);
    }
    for (const f of ["booking-calendly-created", "booking-calendly-canceled", "booking-calendly-created-rescheduled"]) {
      expect(JSON.stringify(parseCalendly(fx(f)))).not.toMatch(/@|\+1000|Private|video|zoom|Sara/);
    }

    // unknown events and a wrong trigger are ignore, whatever else the body says
    const cc = fx("booking-calcom-created");
    expect(parseCalcom({ ...cc, triggerEvent: "MEETING_ENDED" })).toEqual(IGNORE);
    expect(parseCalcom({ ...cc, triggerEvent: "booking_created" })).toEqual(IGNORE);
    const cy = fx("booking-calendly-created");
    expect(parseCalendly({ ...cy, event: "invitee_no_show.created" })).toEqual(IGNORE);
    expect(parseCalendly({ ...cy, event: "routing_form_submission.created" })).toEqual(IGNORE);

    // missing or invalid fields are ignore and never throw, for any input
    const junk: unknown[] = [null, undefined, 0, 1, "", "x", true, [], [1], {}, { payload: null }, { payload: [] }, { payload: "x" }, { triggerEvent: 5 }, { event: {} }];
    for (const j of junk) {
      expect(() => parseCalcom(j)).not.toThrow();
      expect(() => parseCalendly(j)).not.toThrow();
      expect(parseCalcom(j)).toEqual(IGNORE);
      expect(parseCalendly(j)).toEqual(IGNORE);
    }
    const mutate = <T,>(base: unknown, fn: (o: any) => void): T => { const o = clone(base); fn(o); return o as T; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const calBad: Array<(o: any) => void> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      o => delete o.payload.uid, o => { o.payload.uid = 7; }, o => { o.payload.uid = ""; }, o => delete o.payload.startTime, o => delete o.payload.endTime,
      o => { o.payload.startTime = "not a date"; }, o => { o.payload.endTime = 12; }, o => { o.payload.endTime = o.payload.startTime; },
      o => delete o.payload.attendees, o => { o.payload.attendees = []; }, o => { o.payload.attendees = [null]; }, o => { o.payload.attendees = [{ email: "a@example.com" }]; },
      o => { o.payload.attendees = [{ name: "   " }]; },
    ];
    for (const fn of calBad) expect(parseCalcom(mutate(fx("booking-calcom-created"), fn))).toEqual(IGNORE);
    const cyBad: Array<(o: any) => void> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      o => delete o.payload.uri, o => { o.payload.uri = 5; }, o => delete o.payload.name, o => { o.payload.name = ""; }, o => delete o.payload.scheduled_event,
      o => { o.payload.scheduled_event = null; }, o => delete o.payload.scheduled_event.start_time, o => { o.payload.scheduled_event.end_time = "soon"; },
      o => { o.payload.scheduled_event.end_time = o.payload.scheduled_event.start_time; },
    ];
    for (const fn of cyBad) expect(parseCalendly(mutate(fx("booking-calendly-created"), fn))).toEqual(IGNORE);
    // a cancel needs only the id: the item is found through it
    expect(parseCalcom(mutate(fx("booking-calcom-cancelled"), o => { delete o.payload.attendees; delete o.payload.startTime; delete o.payload.endTime; }))).toMatchObject({ kind: "cancel", externalId: "bk_uid_aaaaaaaaaaaaaaaa" });
    expect(parseCalendly(mutate(fx("booking-calendly-canceled"), o => { delete o.payload.scheduled_event; delete o.payload.name; }))).toMatchObject({ kind: "cancel", externalId: I1 });
    expect(parseCalcom(mutate(fx("booking-calcom-cancelled"), o => delete o.payload.uid))).toEqual(IGNORE);
    // an old id that is not a string is no old id: the create stays a create
    expect(parseCalendly(mutate(fx("booking-calendly-created"), o => { o.payload.old_invitee = 5; }))).toMatchObject({ kind: "create" });
    expect(parseCalendly(mutate(fx("booking-calendly-created"), o => { o.payload.old_invitee = ""; })).oldExternalId).toBeUndefined();
    // a Cal.com reschedule without the previous uid still moves (the id is unknown, the caller creates)
    expect(parseCalcom(mutate(fx("booking-calcom-rescheduled"), o => delete o.payload.rescheduleUid))).toMatchObject({ kind: "move", externalId: "bk_uid_bbbbbbbbbbbbbbbb" });

    // every string is bounded, cleaned (controls and direction marks removed) and every instant is ISO UTC
    const long = "x".repeat(5000);
    const dirty = `‮Omar\u0000\n\t  ${"ا".repeat(300)}`;
    const big = parseCalcom(mutate(fx("booking-calcom-rescheduled"), o => {
      o.payload.uid = "a" + long; o.payload.rescheduleUid = "b" + long; o.payload.eventTitle = long; o.payload.attendees = [{ name: dirty }];
      o.payload.startTime = "2026-10-14T13:00:00+03:00"; o.payload.endTime = "2026-10-14T13:30:00+03:00";
    }));
    expect(big.kind).toBe("move");
    expect(big.externalId.length).toBeLessThanOrEqual(200);
    expect(big.oldExternalId!.length).toBeLessThanOrEqual(200);
    expect(big.eventName.length).toBeLessThanOrEqual(120);
    expect(big.name.length).toBeLessThanOrEqual(80);
    expect(big.name).toMatch(/^Omar ا+$/);
    expect(big.name).not.toMatch(/[‮\u0000\n\t]/);
    expect(big.start).toBe("2026-10-14T10:00:00.000Z");
    expect(big.end).toBe("2026-10-14T10:30:00.000Z");
    const bigCy = parseCalendly(mutate(fx("booking-calendly-created-rescheduled"), o => {
      o.payload.uri = "a" + long; o.payload.old_invitee = "b" + long; o.payload.name = dirty; o.payload.scheduled_event.name = long;
    }));
    expect(bigCy.kind).toBe("move");
    expect(bigCy.externalId.length).toBeLessThanOrEqual(200);
    expect(bigCy.oldExternalId!.length).toBeLessThanOrEqual(200);
    expect(bigCy.eventName.length).toBeLessThanOrEqual(120);
    expect(bigCy.name.length).toBeLessThanOrEqual(80);
    expect(bigCy.name).not.toMatch(/[‮\u0000\n\t]/);
  });
});
