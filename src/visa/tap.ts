import { createPublicKey, verify as cryptoVerify, constants, type KeyObject } from "node:crypto";
import { z } from "zod";

/**
 * TAP-style RFC 9421 verification only. This module does not connect to Visa.
 *
 * Reference samples reviewed:
 * - https://github.com/visa/trusted-agent-protocol/blob/main/tap-agent/agent_app.py
 *   builds an RFC 9421 signature base over @authority and @path and signs it
 *   with RSA-PSS-SHA256, carrying created/expires/keyId/alg/nonce/tag.
 * - https://github.com/visa/trusted-agent-protocol/blob/main/cdn-proxy/server.js
 *   parses those fields, looks up keyId in a registry, and verifies RSA-PSS or
 *   Ed25519 signatures. The verifier below follows that sample shape, while
 *   using explicit local key/nonce registries and strict expected bindings.
 */

export type TapAlgorithm = "ed25519" | "rsa-pss-sha256";
export type TapPublicKey = string | Buffer | KeyObject;

export interface TapKeyRecord {
  keyId: string;
  algorithm: TapAlgorithm;
  publicKey: TapPublicKey;
}

export interface TapKeyRegistry {
  get(keyId: string): TapKeyRecord | undefined;
}

export class InMemoryTapKeyRegistry implements TapKeyRegistry {
  private readonly keys = new Map<string, TapKeyRecord>();

  constructor(records: readonly TapKeyRecord[] = []) {
    for (const record of records) this.register(record);
  }

  register(record: TapKeyRecord): void {
    this.keys.set(record.keyId, record);
  }

  get(keyId: string): TapKeyRecord | undefined {
    return this.keys.get(keyId);
  }
}

export interface TapNonceStore {
  /** Atomically records nonce; false means that it was already seen. */
  consume(keyId: string, nonce: string, expiresAt: number, now: number): boolean;
}

/** Process-local demo replay guard; production deployments need shared atomic storage. */
export class InMemoryTapNonceStore implements TapNonceStore {
  private readonly seen = new Map<string, number>();

  consume(keyId: string, nonce: string, expiresAt: number, now: number): boolean {
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key);
    }
    const compound = `${keyId}\u0000${nonce}`;
    if (this.seen.has(compound)) return false;
    this.seen.set(compound, expiresAt);
    return true;
  }
}

export interface TapRequest {
  /** HTTP authority (host[:port]) as received by the verifier. */
  authority: string;
  /** Request target path, including query if that is the signed @path. */
  path: string;
}

export interface TapVerificationOptions {
  request: TapRequest;
  expectedAuthority: string;
  expectedPath: string;
  /** Optional operation tag expected in Signature-Input. */
  expectedTag?: string;
  keyRegistry: TapKeyRegistry;
  nonceStore: TapNonceStore;
  now?: Date;
  maxAgeSeconds?: number;
  clockSkewSeconds?: number;
}

export interface TapVerificationResult {
  verified: boolean;
  reasons: string[];
  authority?: string;
  path?: string;
  keyId?: string;
  nonce?: string;
  tag?: string;
  created?: number;
  expires?: number;
}

const signatureInputSchema = z.object({
  label: z.string().regex(/^[A-Za-z*][A-Za-z0-9_.*-]*$/),
  components: z.array(z.string()).min(1),
  created: z.number().int().nonnegative(),
  expires: z.number().int().positive(),
  keyId: z.string().min(1).max(256),
  algorithm: z.enum(["ed25519", "rsa-pss-sha256"]),
  nonce: z.string().min(1).max(512),
  tag: z.string().min(1).max(256)
});

type ParsedSignatureInput = z.infer<typeof signatureInputSchema> & { rawParams: string };

// This parser intentionally accepts the single-label, quoted-string/decimal
// parameter form used by the Visa samples; it rejects ambiguous/unparsed tails.
function parseSignatureInput(header: string): ParsedSignatureInput | undefined {
  const match = /^([A-Za-z*][A-Za-z0-9_.*-]*)=\(([^)]*)\);\s*(.+)$/.exec(header.trim());
  if (!match) return undefined;
  const [, label, rawComponents, rawParams] = match;
  const components: string[] = [];
  const componentPattern = /"([^"\\]+)"/g;
  let componentMatch: RegExpExecArray | null;
  let consumed = "";
  while ((componentMatch = componentPattern.exec(rawComponents)) !== null) {
    components.push(componentMatch[1]);
    consumed += componentMatch[0];
  }
  if (rawComponents.replace(componentPattern, "").trim() !== "") return undefined;

  const attributes: Record<string, string | number> = {};
  const attrPattern = /(?:^|;\s*)([A-Za-z][A-Za-z0-9_-]*)=("(?:[^"\\]|\\.)*"|[0-9]+)/g;
  let cursor = 0;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrPattern.exec(rawParams)) !== null) {
    if (attrMatch.index !== cursor) return undefined;
    const key = attrMatch[1];
    const value = attrMatch[2];
    if (Object.hasOwn(attributes, key)) return undefined;
    attributes[key] = value.startsWith('"')
      ? value.slice(1, -1).replace(/\\(["\\])/g, "$1")
      : Number(value);
    cursor = attrPattern.lastIndex;
  }
  if (cursor !== rawParams.length) return undefined;
  const keyId = attributes.keyId ?? attributes.keyid;
  const algorithm = attributes.alg;
  const parsed = signatureInputSchema.safeParse({
    label,
    components,
    created: attributes.created,
    expires: attributes.expires,
    keyId,
    algorithm,
    nonce: attributes.nonce,
    tag: attributes.tag
  });
  return parsed.success ? { ...parsed.data, rawParams } : undefined;
}

function parseSignature(header: string, label: string): Buffer | undefined {
  const match = new RegExp(`^${label.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}=:(?<bytes>[A-Za-z0-9+/]+={0,2}):$`).exec(header.trim());
  if (!match?.groups?.bytes) return undefined;
  const encoded = match.groups.bytes;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.toString("base64") === encoded ? bytes : undefined;
}

function signatureBase(input: ParsedSignatureInput, request: TapRequest): string | undefined {
  const lines: string[] = [];
  for (const component of input.components) {
    if (component === "@authority") lines.push(`"@authority": ${request.authority}`);
    else if (component === "@path") lines.push(`"@path": ${request.path}`);
    else return undefined;
  }
  lines.push(`"@signature-params": (${input.components.map((item) => `"${item}"`).join(" ")}); ${input.rawParams}`);
  return lines.join("\n");
}

function asPublicKey(value: TapPublicKey): KeyObject {
  if (typeof value === "string" || Buffer.isBuffer(value)) return createPublicKey(value);
  return value;
}

/** Verify one TAP-style RFC 9421 HTTP Message Signature against local policy. */
export function verifyTapSignature(
  headers: { signatureInput: string; signature: string },
  options: TapVerificationOptions
): TapVerificationResult {
  const parsed = parseSignatureInput(headers.signatureInput);
  if (!parsed) return { verified: false, reasons: ["invalid Signature-Input"] };
  const base = signatureBase(parsed, options.request);
  const signature = parseSignature(headers.signature, parsed.label);
  const baseResult: TapVerificationResult = {
    verified: false,
    reasons: [],
    authority: options.request.authority,
    path: options.request.path,
    keyId: parsed.keyId,
    nonce: parsed.nonce,
    tag: parsed.tag,
    created: parsed.created,
    expires: parsed.expires
  };
  if (!signature || !base) return { ...baseResult, reasons: ["invalid signature encoding or covered component"] };
  if (!parsed.components.includes("@authority") || !parsed.components.includes("@path")) {
    return { ...baseResult, reasons: ["signature must cover @authority and @path"] };
  }
  if (options.request.authority !== options.expectedAuthority) {
    return { ...baseResult, reasons: ["authority/domain binding mismatch"] };
  }
  if (options.request.path !== options.expectedPath) {
    return { ...baseResult, reasons: ["path/operation binding mismatch"] };
  }
  if (options.expectedTag !== undefined && parsed.tag !== options.expectedTag) {
    return { ...baseResult, reasons: ["signature operation tag mismatch"] };
  }
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const skew = options.clockSkewSeconds ?? 0;
  const maxAge = options.maxAgeSeconds ?? 300;
  if (parsed.created > now + skew) return { ...baseResult, reasons: ["signature created in the future"] };
  if (parsed.expires <= now - skew) return { ...baseResult, reasons: ["signature expired"] };
  if (parsed.expires <= parsed.created || parsed.expires - parsed.created > maxAge) {
    return { ...baseResult, reasons: ["invalid signature lifetime"] };
  }
  const record = options.keyRegistry.get(parsed.keyId);
  if (!record) return { ...baseResult, reasons: ["unknown keyId"] };
  if (record.algorithm !== parsed.algorithm) return { ...baseResult, reasons: ["signature algorithm does not match registered key"] };

  let cryptographicallyValid = false;
  try {
    const publicKey = asPublicKey(record.publicKey);
    cryptographicallyValid = record.algorithm === "ed25519"
      ? cryptoVerify(null, Buffer.from(base, "utf8"), publicKey, signature)
      : cryptoVerify("sha256", Buffer.from(base, "utf8"), {
        key: publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_MAX_SIGN
      }, signature);
  } catch {
    return { ...baseResult, reasons: ["registered public key could not verify this signature"] };
  }
  if (!cryptographicallyValid) return { ...baseResult, reasons: ["invalid signature"] };
  if (!options.nonceStore.consume(parsed.keyId, parsed.nonce, parsed.expires, now)) {
    return { ...baseResult, reasons: ["nonce replay refused"] };
  }
  return { ...baseResult, verified: true, reasons: [] };
}
