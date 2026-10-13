import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_MODELS, MEDIA_MODEL_IDS, aspectFor, hasArtwork, isMediaModelId, isOurMediaUrl, isOurOutgoingMediaUrl, mediaImageFor, ourMediaName, mediaModel, plural,
  type MediaModelId,
} from "@/lib/media-catalog";
import { appDict } from "@/lib/app-i18n";
import { availableModels, callbackUrl, offModels, type OffMap } from "@/lib/media/config";
import { PROVIDER_TASK_ID, abortAfter, budget, deadlineFor, mk, parseOpenMember } from "@/lib/media/keys";
import { db } from "@/lib/db";
import { fakeAdapter, fakeDeps, mediaEnv, noNetwork, resetMediaCounters } from "./helpers/media";

/**
 * The media catalogue is what the owner reads before paying: the price beside each label is the price charged, and
 * every hint must say what the model does and does not do, with no quality claim. It is also the one place that decides
 * which image may leave the building as a reference (spec A9, A26) and which models this deployment offers (A21, A22).
 */
beforeEach(resetMediaCounters);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const OUR = "https://abc.public.blob.vercel-storage.com/media/x.jpg";
const KIE = ["img-balanced", "img-premium", "img-text", "vid-quick", "vid-sound", "vid-premium"];
const HF = ["img-lifestyle", "img-design", "vid-cinematic", "vid-motion"];
const texts = (pick: (m: (typeof MEDIA_MODELS)[number]) => string[]) => MEDIA_MODELS.flatMap((m) => pick(m).map((s) => [m.id, s] as const));
/** Whole word in Arabic: `\b` knows only ASCII word characters, so a letter or a mark on either side means "inside a word". */
const arWord = (w: string) => new RegExp(`(^|[^\\p{L}\\p{M}])${w}($|[^\\p{L}\\p{M}])`, "u");

describe("catalogue entries and prices", () => {
  it("ids are unique and every kind matches its id prefix", () => {
    expect(new Set(MEDIA_MODEL_IDS).size).toBe(MEDIA_MODELS.length);
    for (const m of MEDIA_MODELS) expect(m.id.startsWith(m.kind === "image" ? "img-" : "vid-"), m.id).toBe(true);
    for (const m of MEDIA_MODELS) expect(mediaModel(m.id)).toBe(m);
  });

  it("credits are pinned: a change here is a pricing change (founder decision F3)", () => {
    const price = Object.fromEntries(MEDIA_MODELS.map((m) => [m.id, m.credits]));
    expect(price).toEqual({
      "img-fast": 1, "img-balanced": 1, "img-premium": 2, "img-text": 1, "img-lifestyle": 1, "img-design": 1,
      "vid-quick": 12, "vid-sound": 12, "vid-premium": 24, "vid-cinematic": 12, "vid-motion": 12,
    });
  });

  it("a clip's length is on its label, in both languages, and only video has one", () => {
    const secs = Object.fromEntries(MEDIA_MODELS.filter((m) => m.seconds !== undefined).map((m) => [m.id, m.seconds]));
    expect(secs).toEqual({ "vid-quick": 5, "vid-sound": 8, "vid-premium": 10, "vid-cinematic": 5, "vid-motion": 6 });
    for (const m of MEDIA_MODELS.filter((x) => x.kind === "video")) {
      expect(m.label.en, m.id).toContain(`${m.seconds}s`);
      expect(m.label.ar, m.id).toContain(`${m.seconds} ث`);
    }
  });
});

describe("catalogue copy", () => {
  it("no label or hint in either language makes a quality claim", () => {
    const claim = /sharper|more detail|best|أدق|أفضل|احترافي/i;
    const all = texts((m) => [m.label.en, m.label.ar, m.hint.en, m.hint.ar]);
    expect(all.filter(([, s]) => claim.test(s))).toEqual([]);
  });

  it("only the English headline model mentions Arabic lettering, and it says it is not supported", () => {
    const arabic = /arabic|عرب/i;
    expect(texts((m) => [m.hint.en, m.hint.ar]).filter(([id, s]) => id !== "img-text" && arabic.test(s))).toEqual([]);
    const t = mediaModel("img-text");
    expect(t.hint.en).toContain("not supported");
    expect(t.hint.ar).toContain("غير مدعومة");
  });

  it("the premium image says it does not use the owner's real product photo", () => {
    const p = mediaModel("img-premium");
    expect(p.hint.en).toMatch(/does not use a photo of your real product/);
    // The image is the subject: «لا تستخدم صورة منتجك» alone reads as an order to the owner ("don't use your photo").
    expect(p.hint.ar).toContain("الصورة لا تُبنى على صورة منتجك الحقيقية");
  });

  it("no Arabic hint opens a sentence with «لا ت…», which reads as an order to the owner, not as what the model does", () => {
    const opens = /(^|[.؛،!?؟]\s*)لا ت/u;
    expect(opens.test("أعلى دقة. لا تستخدم صورة منتجك.")).toBe(true);
    expect(opens.test("الصورة لا تُبنى على صورة منتجك.")).toBe(false);
    expect(texts((m) => [m.hint.ar]).filter(([, s]) => opens.test(s))).toEqual([]);
  });

  it("every model with sound says there is no voice-over", () => {
    const sound = MEDIA_MODELS.filter((m) => /sound|audio/i.test(m.label.en + " " + m.hint.en) && !/no sound/i.test(m.hint.en));
    expect(sound.map((m) => m.id).sort()).toEqual(["vid-premium", "vid-sound"]);
    for (const m of sound) {
      expect(m.hint.en, m.id).toContain("no voice-over");
      expect(m.hint.ar, m.id).toContain("بلا تعليق صوتي");
    }
  });

  it("no Arabic label or hint uses a gendered imperative as a whole word", () => {
    const words = ["راجع", "ولّد", "اختر"];
    // The check must still see the word, and must not fire on «مولّدة», which contains «ولّد» legitimately.
    expect(arWord("ولّد").test("ولّد صورة")).toBe(true);
    expect(arWord("ولّد").test("صورة مولّدة")).toBe(false);
    const found = texts((m) => [m.label.ar, m.hint.ar]).filter(([, s]) => words.some((w) => arWord(w).test(s)));
    expect(found).toEqual([]);
  });

  it("no label or hint names a vendor or a model", () => {
    const vendor = /fal|kie|higgsfield|flux|banana|gpt|kling|veo|seedance|hailuo|minimax|recraft|soul|google|openai/i;
    expect(texts((m) => [m.label.en, m.label.ar, m.hint.en, m.hint.ar]).filter(([, s]) => vendor.test(s))).toEqual([]);
  });
});

describe("counts in the inbox strings", () => {
  const COUNTED = ["credits", "charged", "confirmCost", "confirmReplace", "needCredits", "mediaLastFailed"] as const;
  const fill = (s: string, n: number) => plural(s, n, { n, need: n, have: 0 });
  // The price on a model card is the number, a space, then the word (MediaControls).
  const text = (lang: "ar" | "en", k: (typeof COUNTED)[number]) => (k === "credits" ? "{n} " : "") + appDict[lang].inbox[k];

  it("plural picks the singular for 1 only and fills the named values", () => {
    expect(plural("{n} {credit|credits}", 1)).toBe("1 credit");
    expect(plural("{n} {credit|credits}", 12)).toBe("12 credits");
    expect(plural("{n} {credit|credits}", 0)).toBe("0 credits");
    expect(plural("Needs {need} {credit|credits}; you have {have}.", 2, { need: 2, have: 1 })).toBe("Needs 2 credits; you have 1.");
    // A name it was not given, a prototype key included, stays as written.
    expect(plural("{n} {constructor} {x}", 3)).toBe("3 {constructor} {x}");
  });

  it("English never says '1 credits' (a 1-credit image) and every placeholder is filled", () => {
    const bad = COUNTED.flatMap((k) => [1, 2, 12].map((n) => fill(text("en", k), n))).filter((s) => /\b1 credits\b|\b(2|12) credit\b|[{}]/.test(s));
    expect(bad).toEqual([]);
    expect(fill(text("en", "credits"), 1)).toBe("1 credit");
    expect(fill(appDict.en.inbox.charged, 1)).toBe("1 credit used; it comes back automatically if the render fails.");
    expect(fill(appDict.en.inbox.mediaLastFailed, 12)).toBe("The last render did not finish; 12 credits were returned.");
  });

  it("the Arabic strings carry no plural group, so they only get their numbers", () => {
    for (const k of COUNTED) {
      const ar = text("ar", k);
      expect(ar, k).not.toMatch(/\{[^{}]*\|/);
      expect(fill(ar, 1), k).toBe(ar.replace("{n}", "1").replace("{need}", "1").replace("{have}", "0"));
    }
  });
});

describe("inbox messages say what the server does", () => {
  const err = (lang: "ar" | "en") => appDict[lang].inbox.mediaErr;

  it("one_open names the rule: one render at a time per account on these styles, whatever the kind or the brand", () => {
    expect(err("en").one_open).not.toMatch(/of this kind/);
    expect(err("en").one_open).toMatch(/per account/);
    expect(err("en").one_open).toMatch(/another post or brand/);
    expect(err("ar").one_open).not.toContain("من هذا النوع في حسابك");
    expect(err("ar").one_open).toContain("لكل حساب");
    expect(err("ar").one_open).toContain("علامة أخرى");
  });

  it("only media_failed and the failure reasons say credits were returned; media_pending says they come back", () => {
    expect(err("en").media_failed).toMatch(/credits were returned/);
    expect(err("en").media_pending).not.toMatch(/were returned/);
    expect(err("en").media_pending).toMatch(/come back automatically/);
    expect(err("ar").media_pending).not.toContain("أُعيدت");
    expect(err("ar").media_pending).toContain("تُعاد");
  });

  it("in_progress promises only what the card does: it picks the render up, or the owner tries again later", () => {
    expect(err("en").in_progress).not.toMatch(/will show here when it finishes/);
    expect(err("ar").in_progress).not.toContain("وسيظهر هنا عند انتهائه");
  });

  it("the new card notes exist in both languages and use no gendered imperative", () => {
    for (const k of ["redoImageNote", "keepsImage", "pausedNoteImage", "pausedNoteVideo"] as const) {
      expect(appDict.en.inbox[k], k).toBeTruthy();
      expect(appDict.ar.inbox[k], k).toBeTruthy();
      expect(["راجع", "ولّد", "اختر", "حدّث", "جرّب"].filter((w) => arWord(w).test(appDict.ar.inbox[k])), k).toEqual([]);
    }
  });
});

describe("guards", () => {
  it("isMediaModelId accepts every catalogue id and refuses prototype keys, case changes and non-strings", () => {
    expect(MEDIA_MODEL_IDS.every(isMediaModelId)).toBe(true);
    for (const v of ["constructor", "__proto__", "toString", "", "IMG-FAST", "img-fast ", 1, null, undefined, {}]) expect(isMediaModelId(v), String(v)).toBe(false);
  });

  it("hasArtwork: real providers with a URL only", () => {
    for (const p of ["fal", "kie", "higgsfield"]) expect(hasArtwork({ imageUrl: OUR, imageProvider: p }), p).toBe(true);
    expect(hasArtwork({ imageUrl: "https://placehold.co/1.png", imageProvider: "placeholder" }), "a placeholder card is not artwork").toBe(false);
    expect(hasArtwork({ imageUrl: OUR }), "a legacy URL with no recorded provider").toBe(false);
    expect(hasArtwork({ imageProvider: "kie" }), "a provider with no URL").toBe(false);
    expect(hasArtwork({ imageUrl: OUR, imageProvider: "constructor" })).toBe(false);
  });

  it("isOurMediaUrl (rule 1759): our disk store on our own hosts, or a legacy public Blob copy, without credentials", () => {
    const NAME = "0123456789abcdef0123456789abcdef";
    expect(isOurMediaUrl(OUR), "legacy Blob copy during the expand release").toBe(true);
    for (const u of [`https://thakeen.com/m/${NAME}.jpg`, `https://staging.thakeen.com/m/${NAME}.mp4`]) {
      expect(isOurMediaUrl(u), u).toBe(true);
      expect(ourMediaName(u), u).toBe(u.slice(-36));
    }
    for (const u of [
      "http://abc.public.blob.vercel-storage.com/media/x.jpg",
      "https://v3.fal.media/files/x.jpg",
      "https://public.blob.vercel-storage.com.evil.example/x",
      "https://evil.example/.public.blob.vercel-storage.com",
      "https://user:pw@abc.public.blob.vercel-storage.com/media/x.jpg",
      "https://user@abc.public.blob.vercel-storage.com/media/x.jpg",
      `http://thakeen.com/m/${NAME}.jpg`,
      `https://thakeen.com.evil.example/m/${NAME}.jpg`,
      `https://evil.thakeen.com/m/${NAME}.jpg`,
      `https://thakeen.com:8443/m/${NAME}.jpg`,
      `https://u:p@thakeen.com/m/${NAME}.jpg`,
      `https://thakeen.com/m/${NAME.toUpperCase()}.jpg`,
      `https://thakeen.com/m/${NAME}.png`,
      `https://thakeen.com/m/${NAME}.jpg?x=1`,
      `https://thakeen.com/m/${NAME}.jpg#a`,
      `https://thakeen.com/m/../${NAME}.jpg`,
      `https://thakeen.com/x/m/${NAME}.jpg`,
      `https://thakeen.com/m/${NAME.slice(1)}.jpg`,
      "https://drive.google.com/uc?id=abc",
      "https://lh3.googleusercontent.com/abc",
      "https://www.dropbox.com/s/abc/x.jpg",
      "https://onedrive.live.com/download?cid=1",
      undefined,
      "",
      "not a url",
      "javascript:alert(1)//.public.blob.vercel-storage.com",
    ]) {
      expect(isOurMediaUrl(u), String(u)).toBe(false);
      expect(ourMediaName(u), String(u)).toBeNull();
    }
  });

  it("isOurOutgoingMediaUrl (rule 1755): the stored form, or a disk URL with exactly exp and sig", () => {
    const base = `https://thakeen.com/m/${"a".repeat(32)}.jpg`;
    expect(isOurOutgoingMediaUrl(base)).toBe(true);
    expect(isOurOutgoingMediaUrl(OUR)).toBe(true);
    expect(isOurOutgoingMediaUrl(`${base}?exp=1&sig=x`)).toBe(true);
    expect(isOurOutgoingMediaUrl(`${base}?sig=x&exp=1`)).toBe(true);
    for (const u of [`${base}?exp=1`, `${base}?exp=1&sig=x&download=1`, `${base}?exp=1&sig=x#f`, `https://evil.example/m/${"a".repeat(32)}.jpg?exp=1&sig=x`, `${OUR}?exp=1&sig=x`, undefined]) {
      expect(isOurOutgoingMediaUrl(u), String(u)).toBe(false);
    }
  });
});

describe("the reference image a render may send (spec A9, A26)", () => {
  const task = (channel: string, imageProvider: string | undefined, imageUrl: string | undefined = OUR) => ({ channel, imageProvider, imageUrl });

  it("an image model gets our copy of a real generated image, never a hot-link or a placeholder", () => {
    const m = mediaModel("img-balanced");
    expect(mediaImageFor(m, task("instagram", "kie"))).toBe(OUR);
    expect(mediaImageFor(m, task("instagram", "fal", "https://v3.fal.media/files/x.jpg"))).toBeUndefined();
    expect(mediaImageFor(m, task("instagram", "placeholder", "https://placehold.co/1.png"))).toBeUndefined();
    expect(mediaImageFor(m, task("instagram", "placeholder"))).toBeUndefined();
    expect(mediaImageFor(m, task("instagram", undefined))).toBeUndefined();
  });

  it("a model that does not build on the image gets none", () => {
    for (const id of ["img-fast", "img-text", "img-lifestyle", "img-design"] as MediaModelId[]) expect(mediaImageFor(mediaModel(id), task("tiktok", "kie")), id).toBeUndefined();
  });

  it("video takes a first frame only from a portrait image; photo to motion takes it whatever its shape", () => {
    expect(mediaImageFor(mediaModel("vid-quick"), task("tiktok", "kie"))).toBe(OUR);
    expect(mediaImageFor(mediaModel("vid-quick"), task("snapchat", "higgsfield"))).toBe(OUR);
    expect(mediaImageFor(mediaModel("vid-quick"), task("instagram", "kie")), "a square first frame gives a square clip").toBeUndefined();
    expect(mediaImageFor(mediaModel("vid-motion"), task("instagram", "kie"))).toBe(OUR);
    expect(mediaImageFor(mediaModel("vid-motion"), task("instagram", "fal", "https://v3.fal.media/files/x.jpg"))).toBeUndefined();
  });

  it("aspectFor: video and the vertical channels are portrait, everything else square", () => {
    expect(aspectFor("video", "instagram")).toBe("portrait");
    expect(aspectFor("image", "tiktok")).toBe("portrait");
    expect(aspectFor("image", "snapchat")).toBe("portrait");
    expect(aspectFor("image", "instagram")).toBe("square");
    expect(aspectFor("image", "facebook")).toBe("square");
  });
});

describe("which models this deployment offers (spec A21, A22)", () => {
  it("nothing configured offers nothing, not even the default", () => {
    mediaEnv({});
    expect(availableModels()).toEqual([]);
  });

  it("fal alone offers the default image model only", () => {
    mediaEnv({ fal: true });
    expect(availableModels()).toEqual(["img-fast"]);
    expect(availableModels("video")).toEqual([]);
  });

  it("a configured provider is not offered until the founder lists its models", () => {
    mediaEnv({ kie: true, store: true });
    expect(availableModels()).toEqual([]);
    mediaEnv({ kie: true, store: true, models: "all" });
    expect(availableModels()).toEqual(KIE);
    expect(availableModels("image")).toEqual(["img-balanced", "img-premium", "img-text"]);
    mediaEnv({ kie: true, store: true, models: "img-balanced" });
    expect(availableModels()).toEqual(["img-balanced"]);
    mediaEnv({ kie: true, store: true, models: " img-balanced , not-a-model,constructor" });
    expect(availableModels(), "unknown ids in the variable are ignored").toEqual(["img-balanced"]);
  });

  it("kie and Higgsfield need the Blob store; fal does not", () => {
    mediaEnv({ fal: true, kie: true, higgsfield: true, models: "all" });
    expect(availableModels()).toEqual(["img-fast"]);
  });

  it("Higgsfield needs both the key id and the secret", () => {
    mediaEnv({ higgsfield: true, store: true, models: "all" });
    expect(availableModels()).toEqual(HF);
    vi.stubEnv("HIGGSFIELD_API_KEY_SECRET", "");
    expect(availableModels()).toEqual([]);
    mediaEnv({ higgsfield: true, store: true, models: "all" });
    vi.stubEnv("HIGGSFIELD_API_KEY_ID", "");
    expect(availableModels()).toEqual([]);
  });

  it("everything configured and listed offers the whole catalogue", () => {
    mediaEnv({ fal: true, kie: true, higgsfield: true, store: true, models: "all" });
    expect(availableModels()).toEqual(MEDIA_MODEL_IDS);
  });

  it("a model the breaker switched off is withheld until its time runs out", async () => {
    mediaEnv({ kie: true, store: true, models: "all" });
    const now = Date.now();
    await db.set(mk.off(), { "img-balanced": { until: now + 60_000, reason: "store_failed" } } satisfies OffMap);
    expect(availableModels(undefined, await offModels())).toEqual(KIE.filter((id) => id !== "img-balanced"));
    await db.set(mk.off(), { "img-balanced": { until: now - 1, reason: "store_failed" } } satisfies OffMap);
    expect(availableModels(undefined, await offModels())).toEqual(KIE);
  });

  it("offModels reads media:off once and drops expired entries", async () => {
    const now = Date.now();
    await db.set(mk.off(), { "img-balanced": { until: now + 60_000, reason: "a" }, "vid-quick": { until: now - 1, reason: "b" } } satisfies OffMap);
    const get = vi.spyOn(db, "get");
    expect(await offModels(now)).toEqual({ "img-balanced": { until: now + 60_000, reason: "a" } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("media:off");
    await db.del(mk.off());
    expect(await offModels()).toEqual({});
  });
});

describe("callback URL (spec A4)", () => {
  it("only an explicit https origin that is not local", () => {
    for (const o of ["", "http://nashr.example", "https://localhost:3000", "https://127.0.0.1", "https://[::1]:3000", "https://nashr.example/app", "nashr.example"]) {
      vi.stubEnv("APP_ORIGIN", o);
      expect(callbackUrl("kie"), o).toBeUndefined();
    }
    vi.stubEnv("APP_ORIGIN", "https://nashr.example");
    expect(callbackUrl("kie")).toBe("https://nashr.example/api/media/hook/kie");
    vi.stubEnv("APP_ORIGIN", "https://nashr.example/");
    expect(callbackUrl("higgsfield")).toBe("https://nashr.example/api/media/hook/higgsfield");
  });
});

describe("the shared media test helpers", () => {
  it("noNetwork refuses and records every fetch, and restore puts fetch back", async () => {
    const real = globalThis.fetch;
    const net = noNetwork();
    await expect(fetch("https://api.kie.ai/api/v1/jobs/createTask")).rejects.toThrow("network in a test: api.kie.ai");
    net.restore();
    expect(net.hosts).toEqual(["api.kie.ai"]);
    expect(globalThis.fetch).toBe(real);
  });

  it("fake adapters answer like their provider and count on themselves", async () => {
    const signal = new AbortController().signal;
    const input = { model: "img-fast" as const, prompt: "p", aspect: "square" as const };
    const fal = fakeAdapter("fal"), kie = fakeAdapter("kie"), hf = fakeAdapter("higgsfield");
    expect(await fal.submit(input, signal)).toEqual({ state: "done", urls: ["https://v3.fal.media/files/test.jpg"] });
    const k = await kie.submit(input, signal), h = await hf.submit(input, signal);
    expect(k.state === "pending" && PROVIDER_TASK_ID.kie.test(k.providerTaskId)).toBe(true);
    expect(h.state === "pending" && PROVIDER_TASK_ID.higgsfield.test(h.providerTaskId)).toBe(true);
    expect(await kie.status()).toEqual({ state: "pending" });
    await kie.cancel();
    expect([kie.submits.length, kie.statusCalls, kie.cancels]).toEqual([1, 1, 1]);
  });

  it("fakeDeps stores on our disk-store URL and fails the first N copies when asked", async () => {
    const deps = fakeDeps({}, { storeFails: 1 });
    const owner = { scope: "a@x.example", taskId: "t1" };
    await expect(deps.store("https://x.example/a.png", "image", 0, owner)).rejects.toThrow("store_put_failed");
    const s = await deps.store("https://x.example/a.png", "image", 0, owner);
    expect(isOurMediaUrl(s.url)).toBe(true);
    expect(deps.stored[0].owner).toEqual(owner);
    expect(deps.stored).toHaveLength(1);
    expect(() => deps.adapter("kie")).toThrow("no fake adapter for kie");
  });

  it("resetMediaCounters clears the global media counters and leaves per-account keys alone", async () => {
    const month = new Date().toISOString().slice(0, 7);
    await Promise.all([db.incrby("rate:kie:create", 5), db.incrby(`${mk.spend(month)}:kie_centicredits`, 820), db.lock(mk.sweepLock(), 300), db.incrby("rate:media:image:h:a@x.example", 1)]);
    resetMediaCounters();
    expect(await Promise.all([db.get("rate:kie:create"), db.get(`${mk.spend(month)}:kie_centicredits`), db.lock(mk.sweepLock(), 300)])).toEqual([null, null, true]);
    expect(await db.get("rate:media:image:h:a@x.example")).toBe(1);
  });
});

describe("keys and time budgets", () => {
  it("parseOpenMember splits on the LAST bar, since a scope may contain one", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(parseOpenMember(`a|b@x.example#brand|${id}`)).toEqual({ scope: "a|b@x.example#brand", jobId: id });
    expect(parseOpenMember(mk.openMember("owner@x.example", id))).toEqual({ scope: "owner@x.example", jobId: id });
    for (const m of [`a|b@x.example|${id.toUpperCase()}`, `a@x.example|${id.slice(1)}`, `a@x.example|${id}0`, `|${id}`, id, "a@x.example|"]) expect(parseOpenMember(m), m).toBeNull();
  });

  it("budget is never negative and never above the step maximum", () => {
    expect(budget(20_000, 1_000_000, 0)).toBe(20_000);
    expect(budget(20_000, 5_000, 0)).toBe(5_000);
    expect(budget(20_000, 0, 5_000)).toBe(0);
    expect(deadlineFor(120, 0)).toBe(105_000);
    expect(deadlineFor(300, 1_000)).toBe(286_000);
  });

  it("abortAfter runs on setTimeout, so fake timers control it", () => {
    vi.useFakeTimers();
    try {
      const s = abortAfter(1_000);
      vi.advanceTimersByTime(999);
      expect(s.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(s.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
