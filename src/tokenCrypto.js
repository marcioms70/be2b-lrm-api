import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

function getKey() {
  const secret = process.env.META_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("META_ENCRYPTION_KEY não configurada.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptToken(value) {
  if (!value) return null;

  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    content: encrypted.toString("base64")
  };

  return `${VERSION}:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function decryptToken(value) {
  if (!value) return null;

  const [version, encoded] = String(value).split(":");
  if (version !== VERSION || !encoded) {
    throw new Error("Formato do token criptografado inválido.");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.content, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}
