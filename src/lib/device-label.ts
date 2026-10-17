/**
 * A short name for a browser string in the device list (rule 1941): "Chrome on Windows", "Safari on iPhone". Pure and
 * import-free, so the settings page and the tests share it; anything it does not recognise is "Browser" / "device".
 * Order matters: Edge, Opera and Samsung Internet carry "Chrome" too, and Chrome on iOS carries "Safari".
 */
export type DeviceLabel = { browser: string; system: string; mobile: boolean };

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/FxiOS\/|Firefox\//, "Firefox"],
  [/CriOS\/|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "Mac"],
  [/Linux/, "Linux"],
];

export function deviceLabel(ua: string): DeviceLabel {
  const s = typeof ua === "string" ? ua.slice(0, 300) : "";
  const browser = BROWSERS.find(([re]) => re.test(s))?.[1] ?? "";
  const system = SYSTEMS.find(([re]) => re.test(s))?.[1] ?? "";
  return { browser, system, mobile: /Mobi|iPhone|Android/.test(s) };
}

/** The label in the reader's language. */
export function deviceName(ua: string, lang: "ar" | "en"): string {
  const { browser, system } = deviceLabel(ua);
  const b = browser || (lang === "ar" ? "متصفح" : "Browser");
  if (!system) return b;
  return lang === "ar" ? `${b} على ${system}` : `${b} on ${system}`;
}
