import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MediaControls, { RECHECK_GAPS, pollJob, recheckTask, type PollEvent } from "@/components/app/MediaControls";
import { appDict } from "@/lib/app-i18n";
import type { Task } from "@/lib/brand";
import type { MediaModelId } from "@/lib/media-catalog";
import type { PublicJob } from "@/lib/media/types";

/**
 * The inbox card's media controls, rendered to markup, and the two timer chains behind them. What the card says must be
 * what the server will do: it keeps artwork the server keeps, names the real reason a card is closed, and follows a
 * render until the server settles it instead of promising a result it no longer looks for.
 */
const en = appDict.en.inbox;
const OURS = "https://s1.public.blob.vercel-storage.com/media/0123456789abcdef0123456789abcdef.jpg";
const FAL = "https://v3.fal.media/files/old.jpg";
const post = (over: Partial<Task> = {}): Task => ({ id: "mc1", type: "social", channel: "instagram", title: "Weekend offer", body: "Two for one.", status: "pending", createdAt: new Date().toISOString(), lang: "en", ...over });
/** The markup with its text entities decoded, so the dictionary strings can be looked up as written. */
function html(task: Task, available: MediaModelId[], over: { paused?: boolean; credits?: number; plan?: string } = {}) {
  const out = renderToStaticMarkup(createElement(MediaControls, { task, lang: "en", t: appDict.en, available, credits: over.credits ?? 100, plan: over.plan ?? "pro", paused: over.paused ?? false, onChanged: () => {} }));
  return out.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
const imageButton = (h: string) => h.match(/<button[^>]*>(?:↻ )?Generate image<\/button>/)?.[0] ?? "";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the image button never trades artwork for a placeholder", () => {
  it("with no image model, an item with artwork keeps its button closed and says why", () => {
    const h = html(post({ imageUrl: OURS, imageProvider: "kie" }), []);
    expect(imageButton(h)).toMatch(/disabled=""/);
    expect(h).toContain(en.keepsImage);
  });

  it("with no image model and no artwork the button still posts, for the free placeholder", () => {
    const h = html(post(), []);
    expect(imageButton(h)).not.toMatch(/disabled=""/);
    expect(h).not.toContain(en.keepsImage);
    // A placeholder card is not artwork either.
    expect(imageButton(html(post({ imageUrl: "https://placehold.co/1.png", imageProvider: "placeholder" }), []))).not.toMatch(/disabled=""/);
  });

  it("with the default model on, a re-render is offered as before", () => {
    const h = html(post({ imageUrl: OURS, imageProvider: "fal" }), ["img-fast"]);
    expect(imageButton(h)).not.toMatch(/disabled=""/);
    expect(h).not.toContain(en.keepsImage);
  });
});

describe("why Photo to motion is closed", () => {
  const card = (h: string) => h.match(/Photo to motion · 6s[\s\S]*?<\/label>/)?.[0] ?? "";

  it("an image the post shows but that is not our copy asks for a new image, not for a first one", () => {
    const h = card(html(post({ imageUrl: FAL, imageProvider: "fal" }), ["img-fast", "vid-quick", "vid-motion"]));
    expect(h).toContain(en.redoImageNote);
    expect(h).not.toContain(en.needsImageNote);
  });

  it("no image at all, or a placeholder, still says it needs a generated image", () => {
    for (const t of [post(), post({ imageUrl: "https://placehold.co/1.png", imageProvider: "placeholder" })]) {
      const h = card(html(t, ["img-fast", "vid-quick", "vid-motion"]));
      expect(h).toContain(en.needsImageNote);
      expect(h).not.toContain(en.redoImageNote);
    }
  });

  it("our own copy opens the card", () => {
    const h = card(html(post({ imageUrl: OURS, imageProvider: "kie" }), ["img-fast", "vid-quick", "vid-motion"]));
    expect(h).not.toContain(en.needsImageNote);
    expect(h).not.toContain(en.redoImageNote);
  });
});

describe("the paused note names only what a model renders here", () => {
  it("nothing to render but the placeholder: no note", () => {
    expect(html(post(), [], { paused: true })).not.toContain("Content generation is paused");
    expect(html(post({ type: "gbp", channel: "gbp" }), [], { paused: true })).not.toContain("Content generation is paused");
  });

  it("images only, videos only, or both", () => {
    expect(html(post({ type: "gbp", channel: "gbp" }), ["img-fast", "vid-quick"], { paused: true })).toContain(en.pausedNoteImage);
    expect(html(post(), ["img-fast"], { paused: true })).toContain(en.pausedNoteImage);
    expect(html(post(), ["vid-quick"], { paused: true })).toContain(en.pausedNoteVideo);
    expect(html(post(), ["img-fast", "vid-quick"], { paused: true })).toContain(en.pausedNote);
  });

  it("not paused: no note", () => {
    expect(html(post(), ["img-fast", "vid-quick"])).not.toContain("Content generation is paused");
  });
});

describe("following a render", () => {
  const job = (state: PublicJob["state"], createdAt: string): PublicJob => ({ id: "0123456789abcdef0123456789abcdef", kind: "image", model: "img-fast", credits: 1, createdAt, state, ...(state === "failed" ? { error: "timeout" as const } : {}) });

  it("past its max age the card says it is late and keeps asking until the server settles the job", async () => {
    vi.useFakeTimers();
    const createdAt = new Date().toISOString();
    let state: PublicJob["state"] = "running";
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, job: job(state, createdAt) }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const events: PollEvent[] = [];
    const stop = pollJob(job("running", createdAt).id, "image", (e) => events.push(e));

    // 10 minutes of max age and 2 of grace, then a little more.
    await vi.advanceTimersByTimeAsync(13 * 60_000);
    expect(events.filter((e) => e.late)).toHaveLength(1);
    const asked = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch.mock.calls.length - asked, "still asking, once a minute").toBeGreaterThanOrEqual(4);
    expect(fetch.mock.calls.length - asked).toBeLessThanOrEqual(6);
    expect(events.some((e) => e.end), "nothing ended it yet").toBe(false);

    state = "failed";
    await vi.advanceTimersByTimeAsync(61_000);
    expect(events.at(-1)).toMatchObject({ end: "failed", job: { state: "failed", error: "timeout" } });
    const total = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch.mock.calls.length, "a settled job is not asked again").toBe(total);
    stop();
  });

  it("a 404 ends it, and stopping it stops the requests", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const events: PollEvent[] = [];
    pollJob("0123456789abcdef0123456789abcdef", "video", (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(events).toEqual([{ end: "gone" }]);

    const quiet = vi.fn(async () => new Response(JSON.stringify({ ok: true, job: job("running", new Date().toISOString()) }), { status: 200 }));
    vi.stubGlobal("fetch", quiet);
    const stop = pollJob("0123456789abcdef0123456789abcdef", "image", () => {});
    await vi.advanceTimersByTimeAsync(3_000);
    stop();
    const n = quiet.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quiet.mock.calls.length).toBe(n);
  });

  it("after a 409 that named no job, the task is re-read a few times, then left alone", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    recheckTask(refresh);
    let at = 0;
    for (const [k, gap] of RECHECK_GAPS.entries()) {
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(refresh, `before re-read ${k + 1}`).toHaveBeenCalledTimes(k);
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(k + 1);
      at += gap;
    }
    expect(at, "within a minute, the window the message gives").toBeLessThanOrEqual(60_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(RECHECK_GAPS.length);

    const early = vi.fn();
    const stop = recheckTask(early);
    await vi.advanceTimersByTimeAsync(RECHECK_GAPS[0]);
    stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(early, "following the job stops the re-reads").toHaveBeenCalledTimes(1);
  });
});
