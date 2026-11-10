// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID), nur mit WebCrypto.
// Läuft in Cloudflare Workers und in Node 20+.

const enc = new TextEncoder();

export function b64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Neues VAPID-Schlüsselpaar als JWKs. */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    publicJwk: await crypto.subtle.exportKey('jwk', kp.publicKey),
    privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
  };
}
/** Öffentlicher Schlüssel als 65-Byte-Rohformat (base64url), für applicationServerKey. */
export function vapidPublicRaw(publicJwk) {
  return b64u(concat(new Uint8Array([4]), fromB64u(publicJwk.x), fromB64u(publicJwk.y)));
}

async function vapidHeader(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${payload}`));
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${vapidPublicRaw(vapid.publicJwk)}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** Verschlüsselt eine Nachricht für eine Push-Subscription (aes128gcm). */
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = fromB64u(subscription.keys.p256dh);
  const authSecret = fromB64u(subscription.keys.auth);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const data = concat(enc.encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, data));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/**
 * Schickt eine Push-Nachricht. Gibt {ok, status, gone} zurück;
 * gone=true heißt: Subscription existiert nicht mehr und kann gelöscht werden.
 */
export async function sendPush(subscription, message, vapid, subject) {
  const body = await encryptPayload(subscription, JSON.stringify(message));
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(2 * 24 * 3600),
      Urgency: 'high',
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
