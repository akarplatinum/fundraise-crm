// Passwords and sessions, on Web Crypto alone. A session is a signed cookie
// ("<base64 payload>.<hmac>"), so checking one needs no database read.

export const SESSION_DAYS = 30;

// ---- crypto helpers (Web Crypto only — no deps) ----
export const enc = new TextEncoder();
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(s) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
export const hashPassword = (salt, password) => sha256Hex(`${salt}:${password}`);

export async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
// Constant-time compare so a wrong signature can't be probed byte by byte.
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const rid = (p) => `${p}_${hex(crypto.getRandomValues(new Uint8Array(9)))}`;

// ---- sessions (stateless signed cookie: "<b64 payload>.<hmac>") ----
export const b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

export function sessionSecret(env) {
  return env.SESSION_SECRET || env.SITE_PASSWORD || "";
}

export async function makeSession(env, username) {
  const payload = b64url(JSON.stringify({ u: username, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return `${payload}.${await hmac(sessionSecret(env), payload)}`;
}

export async function readSession(env, request) {
  const secret = sessionSecret(env);
  if (!secret) return null;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = decodeURIComponent(m[1]).split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(sig, await hmac(secret, payload))) return null;
  try {
    const data = JSON.parse(unb64url(payload));
    if (!data.exp || data.exp < Date.now()) return null;
    return data.u;
  } catch (_) {
    return null;
  }
}

export function sessionCookie(value, maxAge) {
  return `session=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
