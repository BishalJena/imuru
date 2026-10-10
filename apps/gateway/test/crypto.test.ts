import { describe, expect, it } from "vitest";
import {
  generateApiKey,
  hashPassword,
  parseApiKey,
  Sealer,
  sha256,
  TokenSigner,
  verifyPassword,
} from "../src/crypto.js";

describe("api keys", () => {
  it("round-trips and stores only a hash of the secret", () => {
    const k = generateApiKey();
    const parsed = parseApiKey(k.key)!;
    expect(parsed.keyId).toBe(k.keyId);
    expect(sha256(parsed.secret).equals(k.secretHash)).toBe(true);
    expect(parseApiKey("urk_short_x")).toBeNull();
  });
});

describe("passwords", () => {
  it("verifies the right password only", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
});

describe("Sealer", () => {
  it("encrypts with a random IV and detects tampering", () => {
    const s = new Sealer("k".repeat(40));
    const a = s.seal("token");
    expect(s.seal("token").equals(a)).toBe(false);
    expect(s.open(a)).toBe("token");
    a[a.length - 1] ^= 1;
    expect(() => s.open(a)).toThrow();
    expect(() => new Sealer("other".repeat(10)).open(s.seal("x"))).toThrow();
  });
});

describe("TokenSigner", () => {
  it("accepts valid tokens and rejects tampered or expired ones", () => {
    const t = new TokenSigner("secret".repeat(8));
    const token = t.sign({ uid: "u1", exp: Date.now() + 60_000 });
    expect(t.verify(token)?.uid).toBe("u1");
    expect(t.verify(token.replace("uct_", "uct_x"))).toBeNull();
    expect(t.verify(t.sign({ uid: "u1", exp: Date.now() - 1 }))).toBeNull();
    expect(new TokenSigner("other".repeat(8)).verify(token)).toBeNull();
  });
});
