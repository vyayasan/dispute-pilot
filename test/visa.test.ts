import { constants, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Dispute } from "../src/domain/types.js";
import { FixtureInstructionProvider, mandateEvidence } from "../src/visa/vic.js";
import { InMemoryTapKeyRegistry, InMemoryTapNonceStore, verifyTapSignature, type TapAlgorithm, type TapKeyRecord } from "../src/visa/tap.js";

const now = new Date("2026-10-05T22:00:00.000Z");
const authority = "merchant.example.test";
const path = "/api/disputes/d-1/challenge";
const tag = "dispute-challenge";
const dispute: Dispute = { id: "d-1", amount: 75, currency: "USD", reasonCode: "10.4", stage: "RFI", status: "REQUIRES_RESPONSE", dueAt: "2026-12-01T00:00:00Z" };
const instruction = { instructionId: "instruction-1", maxAmount: 100, currency: "USD", merchant: authority, expiresAt: "2026-10-06T00:00:00.000Z", userAuthenticated: true };

function harness(algorithm: TapAlgorithm = "ed25519") {
  const pair = algorithm === "ed25519"
    ? generateKeyPairSync("ed25519")
    : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key: TapKeyRecord = { keyId: "test-key", algorithm, publicKey: pair.publicKey };
  const keyRegistry = new InMemoryTapKeyRegistry([key]);
  const nonceStore = new InMemoryTapNonceStore();
  let nonceNo = 0;
  const signed = (overrides: Partial<{ created: number; expires: number; nonce: string; authority: string; path: string; tag: string }> = {}) => {
    const created = overrides.created ?? Math.floor(now.getTime() / 1000);
    const expires = overrides.expires ?? created + 120;
    const nonce = overrides.nonce ?? `nonce-${++nonceNo}`;
    const signedAuthority = overrides.authority ?? authority;
    const signedPath = overrides.path ?? path;
    const signedTag = overrides.tag ?? tag;
    const label = "sig2";
    const params = `; created=${created}; expires=${expires}; keyId="test-key"; alg="${algorithm}"; nonce="${nonce}"; tag="${signedTag}"`;
    const input = `${label}=("@authority" "@path")${params}`;
    const base = `"@authority": ${signedAuthority}\n"@path": ${signedPath}\n"@signature-params": ("@authority" "@path")${params}`;
    const bytes = algorithm === "ed25519"
      ? cryptoSign(null, Buffer.from(base), pair.privateKey)
      : cryptoSign("sha256", Buffer.from(base), { key: pair.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_MAX_SIGN });
    return { signatureInput: input, signature: `${label}=:${bytes.toString("base64")}:`, request: { authority: signedAuthority, path: signedPath } };
  };
  const verify = (signedValue = signed(), expectedAuthority = authority, expectedPath = path) => verifyTapSignature(
    { signatureInput: signedValue.signatureInput, signature: signedValue.signature },
    { request: signedValue.request, expectedAuthority, expectedPath, expectedTag: tag, keyRegistry, nonceStore, now }
  );
  return { signed, verify, keyRegistry, nonceStore };
}

describe("TAP-style RFC 9421 verification", () => {
  it("accepts a valid Ed25519 signature and binds authority/path/tag", () => {
    expect(harness().verify().verified).toBe(true);
  });

  it("accepts RSA-PSS-SHA256 signatures used by the Visa TAP sample", () => {
    expect(harness("rsa-pss-sha256").verify().verified).toBe(true);
  });

  it("rejects a tampered signature header", () => {
    const h = harness();
    const signed = h.signed();
    expect(h.verify({ ...signed, signatureInput: signed.signatureInput.replace("test-key", "other-key") }).verified).toBe(false);
  });

  it("rejects stale signatures", () => {
    const h = harness();
    const stale = h.signed({ created: Math.floor(now.getTime() / 1000) - 600, expires: Math.floor(now.getTime() / 1000) - 300 });
    expect(h.verify(stale).reasons).toContain("signature expired");
  });

  it("refuses a replayed nonce", () => {
    const h = harness();
    const signed = h.signed({ nonce: "one-use" });
    expect(h.verify(signed).verified).toBe(true);
    expect(h.verify(signed).reasons).toContain("nonce replay refused");
  });

  it("rejects the wrong authority/domain", () => {
    const h = harness();
    const signed = h.signed();
    expect(h.verify(signed, "other.example.test").reasons).toContain("authority/domain binding mismatch");
  });

  it("rejects the wrong operation/path", () => {
    const h = harness();
    const signed = h.signed();
    expect(h.verify(signed, authority, "/api/other").reasons).toContain("path/operation binding mismatch");
  });

  it("uses nonce scope per key and verifies sample-supported Ed25519", () => {
    const h = harness();
    expect(h.verify().verified).toBe(true);
  });
});

describe("VIC-shaped local instruction adapter", () => {
  it("returns mandate evidence for an authenticated in-limit instruction", () => {
    const provider = new FixtureInstructionProvider([instruction]);
    const loaded = provider.getInstruction("instruction-1");
    expect(loaded).toBeDefined();
    const sig = harness().verify();
    const result = mandateEvidence(sig, loaded!, dispute, now);
    expect(result.verified).toBe(true);
    expect(result.evidenceItem.kind).toBe("mandate");
    expect(result.evidenceItem.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a dispute amount above the mandate", () => {
    const sig = harness().verify();
    const result = mandateEvidence(sig, { ...instruction, maxAmount: 50 }, dispute, now);
    expect(result.verified).toBe(false);
    expect(result.reasons).toContain("dispute amount exceeds instruction mandate");
  });
});
