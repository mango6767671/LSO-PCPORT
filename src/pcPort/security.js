import { createHash, timingSafeEqual } from "node:crypto";

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function normalizeDisplayName(value) {
  if (typeof value !== "string") return null;
  const displayName = value.trim().replace(/\s+/g, " ");
  if (displayName.length < 3 || displayName.length > 24) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{2,23}$/.test(displayName)) return null;
  return displayName;
}

export function passwordIsValid(value) {
  return typeof value === "string" && value.length >= 10 && value.length <= 128;
}

export function hashOpaqueToken(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function safeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
