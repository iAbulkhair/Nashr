import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * A software WebAuthn authenticator for tests (passkeys, rules 2400-2429). It holds one ES256 (P-256) key pair and
 * answers registration with a `none` attestation and sign-in with a real ES256 assertion, so the seam in
 * src/lib/webauthn.ts is exercised with real crypto through @simplewebauthn/server, never mocked.
 *
 * Every field the server checks can be bent per call (challenge, origin, RP ID, the UV flag, the counter, the credential
 * id, the user handle), so a test can build each wrong response on purpose. The credential id is chosen by the caller
 * when it needs a fixed one (the collision cases of rule 2404 / 2428); otherwise it is 32 random bytes.
 */

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

// ---- a tiny CBOR writer: unsigned and negative integers, byte and text strings, maps -------------------------------
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

// ---- flags of authenticatorData (WebAuthn §6.1) ---------------------------------------------------------------------
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export type AttestationIn = {
  challenge: string;
  origin: string;
  rpId: string;
  /** User verification flag; default true. */
  uv?: boolean;
  /** Override the authenticator's credential id (base64url). */
  credId?: string;
  /** The user handle the authenticator stores with the credential (base64url), returned by later assertions. */
  userHandle?: string;
  counter?: number;
};

export type AssertionIn = {
  challenge: string;
  origin: string;
  rpId: string;
  uv?: boolean;
  counter?: number;
  credId?: string;
  /** base64url; `null` sends no user handle at all; absent sends the one stored at attestation. */
  userHandle?: string | null;
};

export type SoftAuthenticator = {
  credId: string;
  publicKey: KeyObject;
  /** The COSE_Key (kty 2, alg -7, crv 1, x, y) as base64url, the value the server stores as `pk`. */
  cosePublicKey: string;
  makeAttestation(i: AttestationIn): RegistrationJSON;
  makeAssertion(i: AssertionIn): AssertionJSON;
};

export type RegistrationJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
  clientExtensionResults: Record<string, never>;
};

export type AssertionJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, never>;
};

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
}

function counterBytes(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

export function softAuthenticator(opts: { credId?: string } = {}): SoftAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const coseKey = cbor(new Map<Cbor, Cbor>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]));
  const credId = opts.credId ?? b64u(randomBytes(32));
  let storedHandle: string | undefined;

  return {
    credId,
    publicKey,
    cosePublicKey: b64u(coseKey),

    makeAttestation(i) {
      const id = i.credId ?? credId;
      const idBytes = Buffer.from(id, "base64url");
      if (i.userHandle !== undefined) storedHandle = i.userHandle;
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(idBytes.length, 0);
      const authData = Buffer.concat([
        sha256(i.rpId),
        Buffer.from([UP | (i.uv === false ? 0 : UV) | AT]),
        counterBytes(i.counter ?? 0),
        Buffer.alloc(16), // AAGUID: zero
        idLen,
        idBytes,
        coseKey,
      ]);
      const attestationObject = cbor(new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]));
      return {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", i.challenge, i.origin)),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },

    makeAssertion(i) {
      const id = i.credId ?? credId;
      const authData = Buffer.concat([
        sha256(i.rpId),
        Buffer.from([UP | (i.uv === false ? 0 : UV)]),
        counterBytes(i.counter ?? 0),
      ]);
      const cdj = clientData("webauthn.get", i.challenge, i.origin);
      // ES256: DER-encoded ECDSA over authenticatorData || SHA-256(clientDataJSON).
      const signature = sign("sha256", Buffer.concat([authData, sha256(cdj)]), privateKey);
      const handle = i.userHandle === null ? undefined : (i.userHandle ?? storedHandle);
      return {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: b64u(cdj),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          ...(handle === undefined ? {} : { userHandle: handle }),
        },
        clientExtensionResults: {},
      };
    },
  };
}
