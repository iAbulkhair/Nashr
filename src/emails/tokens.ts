import tokens from "../../assets/design-tokens.json";

/**
 * The palette an email wears. Mail clients load no stylesheet and most ignore CSS variables, so every colour is written
 * inline. The values are read from assets/design-tokens.json, the one source that src/app/tokens.css is kept from by
 * hand (tests/design-tokens.test.ts holds those two together, tests/mail-templates.test.ts holds these to tokens.css),
 * so no hex value is typed here and none can drift from the product's palette (rule 513).
 */
const c = tokens.primitive.color;
export const COLORS = {
  ink: c.ink.$value,
  muted: c.muted.$value,
  paper: c.paper.$value,
  ground: c.ground.$value,
  lilac: c.lilac.$value,
  lemon: c.lemon.$value,
  gold: c.gold.$value,
} as const;

/**
 * IBM Plex Sans Arabic is the product's body face; a reader that has not got it installed (most) falls back to Tahoma,
 * which Windows and macOS ship and which sets Arabic well, then Arial.
 */
export const FONT = "'IBM Plex Sans Arabic', Tahoma, Arial, sans-serif";
