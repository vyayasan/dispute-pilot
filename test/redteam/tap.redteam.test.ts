import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { InMemoryTapKeyRegistry, InMemoryTapNonceStore, verifyTapSignature } from "../../src/visa/tap.js";

const now = new Date("2026-10-05T22:00:00Z");

describe("red team: TAP key algorithm binding", () => {
  it("rejects an Ed25519 signature when the registered key is mislabeled RSA-PSS", () => {
    const pair = generateKeyPairSync("ed25519");
    const created = Math.floor(now.getTime() / 1000), expires = created + 60;
    const params = `; created=${created}; expires=${expires}; keyId="k"; alg="ed25519"; nonce="n"; tag="op"`;
    const label = "sig1";
    const base = `"@authority": a.example\n"@path": /act\n"@signature-params": ("@authority" "@path")${params}`;
    const bytes = cryptoSign(null, Buffer.from(base), pair.privateKey);
    const result = verifyTapSignature({
      signatureInput: `${label}=("@authority" "@path")${params}`,
      signature: `${label}=:${bytes.toString("base64")}:`,
    }, {
      request: { authority: "a.example", path: "/act" }, expectedAuthority: "a.example", expectedPath: "/act",
      expectedTag: "op", keyRegistry: new InMemoryTapKeyRegistry([{ keyId: "k", algorithm: "rsa-pss-sha256", publicKey: pair.publicKey }]),
      nonceStore: new InMemoryTapNonceStore(), now,
    });
    expect(result.verified).toBe(false);
    expect(result.reasons).toContain("signature algorithm does not match registered key");
  });

  it("accepts only until the configured expiry boundary (with zero skew by default)", () => {
    const pair = generateKeyPairSync("ed25519");
    const created = Math.floor(now.getTime() / 1000), expires = created + 60;
    const params = `; created=${created}; expires=${expires}; keyId="k"; alg="ed25519"; nonce="n"; tag="op"`;
    const label = "sig1";
    const base = `"@authority": a.example\n"@path": /act\n"@signature-params": ("@authority" "@path")${params}`;
    const bytes = cryptoSign(null, Buffer.from(base), pair.privateKey);
    const args = {
      signatureInput: `${label}=("@authority" "@path")${params}`,
      signature: `${label}=:${bytes.toString("base64")}:`,
    };
    const common = {
      request: { authority: "a.example", path: "/act" }, expectedAuthority: "a.example", expectedPath: "/act",
      expectedTag: "op", keyRegistry: new InMemoryTapKeyRegistry([{ keyId: "k", algorithm: "ed25519" as const, publicKey: pair.publicKey }]),
      nonceStore: new InMemoryTapNonceStore(),
    };
    expect(verifyTapSignature(args, { ...common, now: new Date((expires - 1) * 1000) }).verified).toBe(true);
    expect(verifyTapSignature(args, { ...common, now: new Date(expires * 1000) }).reasons).toContain("signature expired");
  });
});
