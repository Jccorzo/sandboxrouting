// Envelope encryption for the provider keys people save. Each saved row gets its own random data
// key (AES-256-GCM); the data key is wrapped by a key-encryption key (KEK) that never leaves its
// home: an environment variable for self-hosting, Cloud KMS on the hosted version. The additional
// authenticated data names the account, the provider and the row's version, so a row's ciphertext
// can't be moved to another account, another provider, or an older or newer version of itself.
//
// back only seals. Opening is for the hosted router, which on the hosted version runs under the
// only service account allowed to decrypt with the KMS key.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface SecretBox {
  /** Wraps a data key under the current KEK. */
  wrap(dataKey: Buffer, aad: Buffer): Promise<{ wrapped: Buffer; kekId: string }>;
  /** Unwraps a data key wrapped under the KEK named kekId. */
  unwrap(wrapped: Buffer, kekId: string, aad: Buffer): Promise<Buffer>;
}

export interface Sealed {
  ciphertext: Buffer;
  wrapped: Buffer;
  kekId: string;
}

export const credentialAad = (accountId: string, provider: string, version: number) => Buffer.from(`sbr-credentials|${accountId}|${provider}|${version}`);

const IV = 12;
const TAG = 16;

function gcmSeal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

function gcmOpen(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < IV + TAG) throw new Error("sealed value is too short");
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV));
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(IV, IV + TAG));
  return Buffer.concat([d.update(sealed.subarray(IV + TAG)), d.final()]);
}

export async function seal(box: SecretBox, plaintext: string, aad: Buffer): Promise<Sealed> {
  const dataKey = randomBytes(32);
  try {
    const ciphertext = gcmSeal(dataKey, Buffer.from(plaintext, "utf8"), aad);
    const { wrapped, kekId } = await box.wrap(dataKey, aad);
    return { ciphertext, wrapped, kekId };
  } finally {
    dataKey.fill(0);
  }
}

export async function open(box: SecretBox, sealed: Sealed, aad: Buffer): Promise<string> {
  const dataKey = await box.unwrap(sealed.wrapped, sealed.kekId, aad);
  try {
    return gcmOpen(dataKey, sealed.ciphertext, aad).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/**
 * KEKs from the environment: SBR_SECRETS_KEY (32 bytes, base64) wraps new rows; keys listed in
 * SBR_SECRETS_OLD_KEYS (comma-separated) still unwrap rows wrapped before a rotation. Each KEK is
 * named by a hash of itself, so a row says which one it needs.
 */
export class LocalSecretBox implements SecretBox {
  private readonly keys = new Map<string, Buffer>();
  private readonly current: string;

  constructor(currentB64: string, oldB64: string[] = []) {
    const parse = (b64: string) => {
      const k = Buffer.from(b64.trim(), "base64");
      if (k.length !== 32) throw new Error("SBR_SECRETS_KEY must be 32 bytes, base64 (try: openssl rand -base64 32)");
      return k;
    };
    const name = (k: Buffer) => `local:${createHash("sha256").update(k).digest("hex").slice(0, 16)}`;
    const cur = parse(currentB64);
    this.current = name(cur);
    this.keys.set(this.current, cur);
    for (const o of oldB64.filter((s) => s.trim())) {
      const k = parse(o);
      this.keys.set(name(k), k);
    }
  }

  async wrap(dataKey: Buffer, aad: Buffer) {
    return { wrapped: gcmSeal(this.keys.get(this.current)!, dataKey, aad), kekId: this.current };
  }

  async unwrap(wrapped: Buffer, kekId: string, aad: Buffer) {
    const k = this.keys.get(kekId);
    if (!k) throw new Error(`no key ${kekId} to unwrap with (rotated out of SBR_SECRETS_OLD_KEYS?)`);
    return gcmOpen(k, wrapped, aad);
  }
}

/**
 * Cloud KMS through its REST API. keyName: projects/…/locations/…/keyRings/…/cryptoKeys/…. The
 * access token comes from the metadata server (Cloud Run's service account) unless one is given.
 * KMS picks the key version itself, and records it in the ciphertext, so rotating the KMS key
 * needs nothing here.
 */
export class KmsSecretBox implements SecretBox {
  private token?: { value: string; until: number };

  constructor(
    private readonly keyName: string,
    private readonly opts: { fetch?: typeof fetch; accessToken?: () => Promise<string> } = {},
  ) {
    if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(keyName)) {
      throw new Error("SBR_KMS_KEY must be projects/…/locations/…/keyRings/…/cryptoKeys/…");
    }
  }

  private get f() {
    return this.opts.fetch ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.opts.accessToken) return this.opts.accessToken();
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const res = await this.f("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "metadata-flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`metadata server answered ${res.status} for a token`);
    const t = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: t.access_token, until: Date.now() + Math.max(0, t.expires_in - 60) * 1000 };
    return t.access_token;
  }

  private async call(op: "encrypt" | "decrypt", body: Record<string, string>): Promise<Record<string, string>> {
    const res = await this.f(`https://cloudkms.googleapis.com/v1/${this.keyName}:${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Cloud KMS ${op} answered ${res.status}`);
    return (await res.json()) as Record<string, string>;
  }

  async wrap(dataKey: Buffer, aad: Buffer) {
    const out = await this.call("encrypt", { plaintext: dataKey.toString("base64"), additionalAuthenticatedData: aad.toString("base64") });
    return { wrapped: Buffer.from(out["ciphertext"]!, "base64"), kekId: `kms:${this.keyName}` };
  }

  async unwrap(wrapped: Buffer, kekId: string, aad: Buffer) {
    if (kekId !== `kms:${this.keyName}`) throw new Error(`this server unwraps with kms:${this.keyName}, not ${kekId}`);
    const out = await this.call("decrypt", { ciphertext: wrapped.toString("base64"), additionalAuthenticatedData: aad.toString("base64") });
    return Buffer.from(out["plaintext"]!, "base64");
  }
}

/**
 * The box this process uses, from its environment, or undefined when saving keys is off. `fetch`:
 * what Cloud KMS and the metadata server are called with (the hosted router passes one that
 * bypasses its egress guard, which refuses the metadata server's link-local address).
 */
export function secretBoxFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { fetch?: typeof fetch } = {}): SecretBox | undefined {
  if (env["SBR_KMS_KEY"]) return new KmsSecretBox(env["SBR_KMS_KEY"], opts.fetch ? { fetch: opts.fetch } : {});
  if (env["SBR_SECRETS_KEY"]) return new LocalSecretBox(env["SBR_SECRETS_KEY"], (env["SBR_SECRETS_OLD_KEYS"] ?? "").split(","));
  return undefined;
}
