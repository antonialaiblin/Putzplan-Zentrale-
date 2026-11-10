import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, generateVapidKeys, vapidPublicRaw, b64u, fromB64u } from '../src/webpush.js';

test('Verschlüsselte Nachricht lässt sich wie im Browser entschlüsseln (RFC 8291)', async () => {
  const ua = nodeCrypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  const sub = { endpoint: 'https://push.example/x', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
  const msg = JSON.stringify({ title: 'Putzplan', body: 'Hey Mo, Bad putzen ✨' });
  const body = await encryptPayload(sub, msg);
  const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: auth });
  assert.equal(plain.toString('utf8'), msg);
});

test('VAPID-Schlüssel', async () => {
  const v = await generateVapidKeys();
  const raw = fromB64u(vapidPublicRaw(v.publicJwk));
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
});
