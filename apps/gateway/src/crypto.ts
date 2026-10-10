import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

export const sha256 = (s: string | Buffer): Buffer => createHash("sha256").update(s).digest();

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Passwords are low-entropy, so they get a slow, memory-hard KDF.
// N=2^15, r=8 costs 32 MiB and roughly 50-100 ms per hash.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = stored?.split("$");
  if (!parts || parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, key] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(key, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return safeEqual(actual, expected);
}

// API keys: urk_<key id>_<secret>. The key id is stored in clear for O(1)
// lookup and for attributing calls even after revocation. The secret has
// 256 bits of entropy, so a single fast SHA-256 is enough; a slow KDF would
// add latency to every MCP request without adding security.
const KEY_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const API_KEY_RE = /^urk_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export function generateApiKey(): { key: string; keyId: string; secretHash: Buffer } {
  const bytes = randomBytes(8);
  const keyId = Array.from(bytes, (b) => KEY_ID_ALPHABET[b % KEY_ID_ALPHABET.length]).join("");
  const secret = randomToken(32);
  return { key: `urk_${keyId}_${secret}`, keyId, secretHash: sha256(secret) };
}

export function parseApiKey(key: string): { keyId: string; secret: string } | null {
  const m = API_KEY_RE.exec(key);
  return m ? { keyId: m[1]!, secret: m[2]! } : null;
}

/** AES-256-GCM: 12-byte IV || 16-byte tag || ciphertext. */
export class Sealer {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    // Accept any string from the Secret; derive a fixed 32-byte key from it.
    this.key = sha256(`urumi-credential-key:${keyMaterial}`);
  }

  seal(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  open(sealed: Buffer): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.subarray(0, 12));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/**
 * Short-lived token that lets the chat agent call the gateway's own /mcp as the
 * logged-in user: uct_<base64url(json)>.<base64url(hmac)>.
 */
export class TokenSigner {
  constructor(private readonly secret: string) {}

  sign(payload: { uid: string; exp: number }): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `uct_${body}.${this.mac(body)}`;
  }

  verify(token: string, now = Date.now()): { uid: string; exp: number } | null {
    if (!token.startsWith("uct_")) return null;
    const [body, mac] = token.slice(4).split(".");
    if (!body || !mac || !safeEqual(Buffer.from(mac), Buffer.from(this.mac(body)))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
        uid: string;
        exp: number;
      };
      return typeof payload.uid === "string" && payload.exp > now ? payload : null;
    } catch {
      return null;
    }
  }

  private mac(body: string): string {
    return createHmac("sha256", `chat-token:${this.secret}`).update(body).digest("base64url");
  }
}
