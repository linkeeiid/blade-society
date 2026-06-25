/* =====================================================================
   BLADE SOCIETY — Worker Cloudflare (notifications push web)
   - POST /subscribe : enregistre l'abonnement du barber (KV "SUBS")
   - POST /notify    : envoie une notification push au barber
   Variables à définir (Settings → Variables) :
     VAPID_PUBLIC   (texte)   = clé publique VAPID
     VAPID_PRIVATE  (secret)  = clé privée VAPID
     VAPID_SUBJECT  (texte)   = mailto:ton-email   (ex: mailto:contact@bladesociety.fr)
   Binding KV (Settings → Variables → KV Namespace Bindings) :
     Variable name = SUBS
   ===================================================================== */

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/subscribe' && req.method === 'POST') {
        const sub = await req.json();
        if (!sub || !sub.endpoint || !sub.keys) return reply({ error: 'bad subscription' }, 400, cors);
        await env.SUBS.put('barber', JSON.stringify(sub));
        return reply({ ok: true }, 200, cors);
      }
      if (url.pathname === '/notify' && req.method === 'POST') {
        const { title, body, url: clickUrl } = await req.json();
        const raw = await env.SUBS.get('barber');
        if (!raw) return reply({ error: 'no subscription' }, 404, cors);
        const sub = JSON.parse(raw);
        const payload = JSON.stringify({
          title: title || 'Blade Society',
          body: body || 'Nouvelle réservation',
          url: clickUrl || './index.html',
        });
        const res = await sendPush(sub, payload, env);
        if (res.status === 404 || res.status === 410) await env.SUBS.delete('barber'); // abonnement expiré
        return reply({ ok: res.ok, status: res.status }, 200, cors);
      }
      return reply({ error: 'not found' }, 404, cors);
    } catch (e) {
      return reply({ error: String((e && e.message) || e) }, 500, cors);
    }
  },
};

function reply(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

/* ---------- utilitaires base64url / bytes ---------- */
function b64uDec(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function b64uEnc(buf) {
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/* ---------- VAPID JWT (ES256) ---------- */
async function vapidJWT(aud, env) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud, exp: now + 12 * 60 * 60, sub: env.VAPID_SUBJECT || 'mailto:contact@bladesociety.fr' };
  const enc = (o) => b64uEnc(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = enc(header) + '.' + enc(payload);

  const pub = b64uDec(env.VAPID_PUBLIC); // 0x04 || X(32) || Y(32)
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64uEnc(pub.slice(1, 33)),
    y: b64uEnc(pub.slice(33, 65)),
    d: env.VAPID_PRIVATE,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return signingInput + '.' + b64uEnc(sig);
}

/* ---------- chiffrement aes128gcm (RFC 8291) + envoi ---------- */
async function sendPush(sub, payloadStr, env) {
  const ua_public = b64uDec(sub.keys.p256dh); // 65
  const auth = b64uDec(sub.keys.auth);        // 16
  const payload = new TextEncoder().encode(payloadStr);

  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const as_public = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey)); // 65
  const uaKey = await crypto.subtle.importKey('raw', ua_public, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256)); // 32

  const keyInfo = concat(new TextEncoder().encode('WebPush: info\0'), ua_public, as_public);
  const ikm = await hkdf(auth, ecdh, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const plaintext = concat(payload, new Uint8Array([2])); // délimiteur dernier enregistrement
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext));

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  header[16] = (rs >>> 24) & 255; header[17] = (rs >>> 16) & 255; header[18] = (rs >>> 8) & 255; header[19] = rs & 255;
  header[20] = 65;
  header.set(as_public, 21);
  const bodyBytes = concat(header, ct);

  const aud = new URL(sub.endpoint).origin;
  const jwt = await vapidJWT(aud, env);

  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '2419200',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC,
    },
    body: bodyBytes,
  });
}
