/* =====================================================================
   BLADE SOCIETY — Worker Cloudflare (notifications push web)
   - POST /subscribe : enregistre l'abonnement du barber (KV "SUBS")
   - POST /notify    : envoie une notification push au barber
   Variables à définir (Settings → Variables) :
     VAPID_PUBLIC   (texte)   = clé publique VAPID
     VAPID_PRIVATE  (secret)  = clé privée VAPID
     VAPID_SUBJECT  (texte)   = mailto:ton-email   (ex: mailto:contact@bladesociety.fr)
   Email de confirmation client (route POST /email, via Brevo) :
     BREVO_API_KEY  (secret)  = clé API Brevo (xkeysib-...)
     SENDER_EMAIL   (texte)   = contact@bladesociety.fr  (expéditeur vérifié dans Brevo)
     SENDER_NAME    (texte)   = Blade Society
   SMS client (via Brevo, PAYANT) — 2 SMS maximum par client :
     SMS_SENDER     (texte)   = nom expéditeur SMS, 11 caractères max (ex: BladeScy)
     -> sans cette variable, aucun SMS n'est envoyé et la réservation reste possible
     1. code de vérification à la 1re réservation d'un numéro (POST /otp/send, plafonné)
     2. rappel 24h avant le rendez-vous (Cron interne)
     La confirmation du rendez-vous se fait UNIQUEMENT par email.
   Rappels automatiques (Cron Trigger) : email ~4h avant + SMS ~24h avant
     FIREBASE_DB_URL (texte)  = https://blade-society-default-rtdb.europe-west1.firebasedatabase.app
     SITE_URL        (texte, optionnel) = https://bladesociety.fr
     + Cron Trigger à ajouter (Settings -> Triggers -> Cron) : toutes les 10 min
       expression cron equivalente : 0,10,20,30,40,50 * * * *
   Binding KV (Settings → Variables → KV Namespace Bindings) :
     Variable name = SUBS

   VÉRIFICATION DU NUMÉRO PAR SMS (anti faux numéros / no-shows)
   - POST /otp/send   {phone}        -> envoie un code à 6 chiffres
                                        répond {skip:true} si le numéro est déjà vérifié (0 SMS)
   - POST /otp/verify {phone, code}  -> valide le code et mémorise le numéro
   Un numéro n'est vérifié qu'UNE FOIS : les réservations suivantes ne coûtent aucun SMS.
   ===================================================================== */

/* --- réglages de la vérification par SMS --- */
const OTP_TTL_S           = 600;            // durée de vie d'un code (10 min)
const OTP_MAX_TRIES       = 5;              // essais de saisie avant invalidation
const OTP_COOLDOWN_S      = 60;             // délai mini entre 2 envois au même numéro
const OTP_MAX_PER_PHONE   = 3;              // codes max par numéro / heure
const OTP_MAX_PER_IP      = 8;              // codes max par appareil (IP) / heure
const OTP_MAX_PROBES_PER_IP = 30;           // requêtes max par appareil / heure (numéros déjà vérifiés inclus)
const OTP_VERIFIED_TTL_S  = 180 * 24 * 3600; // un numéro vérifié le reste 180 jours

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

      /* ====== CMS : galerie photos (gérée par Giovany) ====== */
      if (url.pathname === '/gallery' && req.method === 'GET') {
        const g = await env.SUBS.get('gallery');
        return reply({ photos: g ? JSON.parse(g) : [] }, 200, cors);
      }
      if (url.pathname === '/gallery/add' && req.method === 'POST') {
        const { pw, file } = await req.json();
        if (pw !== env.BARBER_PW) return reply({ error: 'unauthorized' }, 401, cors);
        if (!file) return reply({ error: 'no file' }, 400, cors);
        const up = await cloudinaryUpload(file, env);
        if (!up || !up.secure_url) return reply({ error: 'upload failed', detail: up }, 502, cors);
        const list = JSON.parse((await env.SUBS.get('gallery')) || '[]');
        list.unshift({ url: up.secure_url, id: up.public_id });   // la nouvelle photo passe en premier
        await env.SUBS.put('gallery', JSON.stringify(list));
        return reply({ photos: list }, 200, cors);
      }
      if (url.pathname === '/gallery/remove' && req.method === 'POST') {
        const { pw, id } = await req.json();
        if (pw !== env.BARBER_PW) return reply({ error: 'unauthorized' }, 401, cors);
        let list = JSON.parse((await env.SUBS.get('gallery')) || '[]');
        list = list.filter(p => p.id !== id);
        await env.SUBS.put('gallery', JSON.stringify(list));
        cloudinaryDestroy(id, env);   // libère le stockage Cloudinary (best-effort)
        return reply({ photos: list }, 200, cors);
      }
      if (url.pathname === '/content' && req.method === 'GET') {
        const c = await env.SUBS.get('content');
        return reply({ content: c ? JSON.parse(c) : {} }, 200, cors);
      }
      if (url.pathname === '/content' && req.method === 'POST') {
        const { pw, content } = await req.json();
        const planningPw = env.PLANNING_PW || 'GiovanyBlade';   // barbier connecté = peut éditer horaires/contenu
        if (pw !== env.BARBER_PW && pw !== planningPw) return reply({ error: 'unauthorized' }, 401, cors);
        await env.SUBS.put('content', JSON.stringify(content || {}));
        return reply({ ok: true }, 200, cors);
      }

      /* ====== Coordonnées privées du client (tél) — lisibles seulement par le barber ====== */
      if (url.pathname === '/contact' && req.method === 'POST') {        // enregistre (à la réservation)
        const b = await req.json();
        if (!b || !b.key) return reply({ error: 'bad' }, 400, cors);
        const raw = await env.SUBS.get('contacts');
        const map = raw ? JSON.parse(raw) : {};
        map[b.key] = { phone: b.phone || '', name: b.name || '', email: b.email || '' };
        await env.SUBS.put('contacts', JSON.stringify(map));
        return reply({ ok: true }, 200, cors);
      }
      if (url.pathname === '/contact/remove' && req.method === 'POST') { // supprime (à l'annulation)
        const b = await req.json();
        if (!b || !b.key) return reply({ error: 'bad' }, 400, cors);
        const raw = await env.SUBS.get('contacts');
        if (raw) { const map = JSON.parse(raw); delete map[b.key]; await env.SUBS.put('contacts', JSON.stringify(map)); }
        return reply({ ok: true }, 200, cors);
      }
      if (url.pathname === '/contacts' && req.method === 'POST') {       // lecture (barber connecté)
        const { pw } = await req.json();
        const planningPw = env.PLANNING_PW || 'GiovanyBlade';            // = mot de passe de connexion barber
        if (pw !== planningPw && pw !== env.BARBER_PW) return reply({ error: 'unauthorized' }, 401, cors);
        const raw = await env.SUBS.get('contacts');
        return reply({ contacts: raw ? JSON.parse(raw) : {} }, 200, cors);
      }
      if (url.pathname === '/run-reminders' && req.method === 'POST') {  // déclenche les rappels à la main (test)
        const { pw } = await req.json();
        if (pw !== env.BARBER_PW) return reply({ error: 'unauthorized' }, 401, cors);
        await sendReminders(env);
        return reply({ ok: true }, 200, cors);
      }

      /* ====== Email de confirmation au client (via Brevo) ====== */
      if (url.pathname === '/email' && req.method === 'POST') {
        if (!env.BREVO_API_KEY || !env.SENDER_EMAIL) return reply({ error: 'email not configured' }, 503, cors);
        const b = await req.json();
        if (!b || !b.to_email) return reply({ error: 'no recipient' }, 400, cors);
        const r = await sendBrevoEmail(b, env);
        return reply({ ok: r.ok, status: r.status }, 200, cors);
      }

      /* La route publique POST /sms a été SUPPRIMÉE (2026-07-19).
         Elle envoyait n'importe quel texte à n'importe quel numéro sans aucun contrôle :
         une fois SMS_SENDER activé, n'importe qui connaissant l'URL du Worker pouvait
         vider le crédit SMS de Giovany. Plus aucun appelant légitime depuis que la
         confirmation de rendez-vous se fait uniquement par email.
         Les seuls envois de SMS restants sont le code de vérification (/otp/send,
         plafonné) et le rappel 24h (Cron interne). */

      /* ====== Vérification du numéro par SMS : envoi du code ======
         Ne consomme un SMS que pour un numéro jamais vérifié. */
      if (url.pathname === '/otp/send' && req.method === 'POST') {
        const b = await req.json();
        const to = normalizeFrPhone(b && b.phone);
        if (!to) return reply({ error: 'bad_phone' }, 400, cors);

        // borne TOUTES les requêtes d'un appareil, y compris pour un numéro déjà vérifié :
        // empêche de tester en masse quels numéros sont clients du salon
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        const nProbe = parseInt((await env.SUBS.get('otpq:' + ip)) || '0', 10);
        if (nProbe >= OTP_MAX_PROBES_PER_IP) return reply({ error: 'too_many' }, 429, cors);
        await env.SUBS.put('otpq:' + ip, String(nProbe + 1), { expirationTtl: 3600 });

        // numéro déjà vérifié -> aucun SMS, le client réserve directement
        if (await env.SUBS.get('verified:' + to)) return reply({ ok: true, skip: true }, 200, cors);
        if (!env.BREVO_API_KEY || !env.SMS_SENDER) return reply({ error: 'sms not configured' }, 503, cors);

        // garde-fous anti-abus : protègent le crédit SMS de Giovany
        const nowSec = Math.floor(Date.now() / 1000);
        const prev = JSON.parse((await env.SUBS.get('otp:' + to)) || 'null');
        if (prev && nowSec - prev.ts < OTP_COOLDOWN_S) {
          return reply({ error: 'cooldown', retry_in: OTP_COOLDOWN_S - (nowSec - prev.ts) }, 429, cors);
        }
        const nPhone = parseInt((await env.SUBS.get('otprl:' + to)) || '0', 10);
        if (nPhone >= OTP_MAX_PER_PHONE) return reply({ error: 'too_many' }, 429, cors);
        const nIp = parseInt((await env.SUBS.get('otpip:' + ip)) || '0', 10);
        if (nIp >= OTP_MAX_PER_IP) return reply({ error: 'too_many' }, 429, cors);

        const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
        // rappel du créneau en attente : le SMS se suffit à lui-même (on reste sur 1 seul SMS facturé)
        const slotTxt = String((b && b.slot) || '').replace(/[^0-9A-Za-z\s:\/h.-]/g, '').slice(0, 40).trim();
        const content = 'Blade Society\n'
          + 'Votre code de confirmation : ' + code + '\n'
          + (slotTxt ? 'RDV du ' + slotTxt + '\n' : '')
          + 'Valable 10 minutes.';
        const r = await sendBrevoSms(to, content, env);
        if (!r.ok) return reply({ error: 'sms_failed', status: r.status }, 502, cors);
        await env.SUBS.put('otp:' + to, JSON.stringify({ code, ts: nowSec, tries: 0 }), { expirationTtl: OTP_TTL_S });
        await env.SUBS.put('otprl:' + to, String(nPhone + 1), { expirationTtl: 3600 });
        await env.SUBS.put('otpip:' + ip, String(nIp + 1), { expirationTtl: 3600 });
        return reply({ ok: true, sent: true }, 200, cors);
      }

      /* ====== Vérification du numéro par SMS : contrôle du code ====== */
      if (url.pathname === '/otp/verify' && req.method === 'POST') {
        const b = await req.json();
        const to = normalizeFrPhone(b && b.phone);
        const code = String((b && b.code) || '').replace(/\D/g, '');
        if (!to || code.length !== 6) return reply({ error: 'bad_request' }, 400, cors);
        const rec = JSON.parse((await env.SUBS.get('otp:' + to)) || 'null');
        if (!rec) return reply({ error: 'expired' }, 400, cors);
        if (rec.tries >= OTP_MAX_TRIES) {
          await env.SUBS.delete('otp:' + to);
          return reply({ error: 'too_many_tries' }, 429, cors);
        }
        if (rec.code !== code) {
          rec.tries++;
          const left = Math.max(0, nowLeft(rec.ts));
          await env.SUBS.put('otp:' + to, JSON.stringify(rec), { expirationTtl: left });
          return reply({ error: 'bad_code', tries_left: OTP_MAX_TRIES - rec.tries }, 400, cors);
        }
        await env.SUBS.delete('otp:' + to);
        await env.SUBS.put('verified:' + to, '1', { expirationTtl: OTP_VERIFIED_TTL_S });
        return reply({ ok: true, verified: true }, 200, cors);
      }
      if (url.pathname === '/gallery/order' && req.method === 'POST') {
        const { pw, ids } = await req.json();
        if (pw !== env.BARBER_PW) return reply({ error: 'unauthorized' }, 401, cors);
        const list = JSON.parse((await env.SUBS.get('gallery')) || '[]');
        const byId = {}; list.forEach(p => byId[p.id] = p);
        const ordered = ids.map(id => byId[id]).filter(Boolean);
        await env.SUBS.put('gallery', JSON.stringify(ordered));
        return reply({ photos: ordered }, 200, cors);
      }

      return reply({ error: 'not found' }, 404, cors);
    } catch (e) {
      return reply({ error: String((e && e.message) || e) }, 500, cors);
    }
  },

  /* ====== Rappel automatique ~4h avant le RDV (déclenché par le Cron Trigger) ====== */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env));
  },
};

function reply(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

/* ---------- Téléphone FR -> format international Brevo (33XXXXXXXXX, sans +) ---------- */
function normalizeFrPhone(raw) {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (s.indexOf('+') > 0) s = s.replace(/\+/g, '');   // + uniquement en tête, sinon on nettoie
  if (s[0] === '+') s = s.slice(1);
  if (s.slice(0, 4) === '0033') s = '33' + s.slice(4);
  else if (s.slice(0, 2) === '33') { /* déjà international */ }
  else if (s[0] === '0') s = '33' + s.slice(1);       // 06... -> 336...
  if (!/^\d{10,15}$/.test(s)) return '';              // garde-fou format
  return s;
}

/* ---------- Envoi d'un SMS via Brevo (payant) ---------- */
async function sendBrevoSms(phone, content, env) {
  const to = normalizeFrPhone(phone);
  if (!to || !env.BREVO_API_KEY || !env.SMS_SENDER) return { ok: false, status: 0 };
  try {
    const r = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ sender: env.SMS_SENDER, recipient: to, content, type: 'transactional' }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, status: 0 }; }
}
// TTL restant d'un code de vérification (KV impose 60 s minimum)
function nowLeft(ts) {
  return Math.max(60, OTP_TTL_S - (Math.floor(Date.now() / 1000) - ts));
}
// nombre de jours entre deux dates ISO (aaaa-mm-jj)
function dayGap(isoA, isoB) {
  const a = isoA.split('-').map(Number), b = isoB.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

/* ---------- Email de confirmation client (HTML) ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clientEmailHtml(b) {
  const name = esc(b.to_name || '');
  const service = esc(b.service || '');
  const price = esc(b.price || '');
  const date = esc(b.date || '');
  const slot = esc(b.slot || '');
  const manageUrl = b.manage_url ? esc(b.manage_url) : '';
  const oldDate = esc(b.old_date || '');
  const oldSlot = esc(b.old_slot || '');
  const isMod = !!(b.old_date && b.old_slot);
  const isReminder = !!b.reminder;
  const row = (label, value) => value
    ? `<tr><td style="padding:8px 0;color:#9b978c;font-size:13px;width:120px">${label}</td><td style="padding:8px 0;color:#1a1a1a;font-size:15px;font-weight:600">${value}</td></tr>`
    : '';
  const step = (n, txt) => `<tr>
    <td valign="top" style="padding:6px 10px 6px 0;width:22px;color:#9b8a5a;font-size:14px;font-weight:700">${n}.</td>
    <td valign="top" style="padding:6px 0;color:#333;font-size:14px;line-height:1.5">${txt}</td></tr>`;

  /* ----- Email d'ANNULATION (sans étapes d'accès ni bouton de gestion) ----- */
  if (b.cancelled) return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:28px 0">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">
        <tr><td style="background:#0a0a0a;padding:26px 30px;text-align:center">
          <div style="color:#cfc7b3;font-size:22px;letter-spacing:.18em;font-weight:700">BLADE SOCIETY</div>
          <div style="color:#7c776c;font-size:11px;letter-spacing:.22em;margin-top:5px">COIFFEUR · BARBIER</div>
        </td></tr>
        <tr><td style="padding:30px 30px 6px">
          <div style="display:inline-block;background:#fdecec;color:#b23b3b;font-size:13px;font-weight:700;padding:7px 14px;border-radius:20px">✕ Rendez-vous annulé</div>
          <p style="color:#1a1a1a;font-size:16px;margin:20px 0 4px">Bonjour ${name},</p>
          <p style="color:#555;font-size:14px;line-height:1.5;margin:0 0 14px">Votre rendez-vous a bien été annulé. Voici le créneau qui a été libéré&nbsp;:</p>
        </td></tr>
        <tr><td style="padding:0 30px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee">
            ${row('Prestation', service)}
            ${row('Date', date)}
            ${row('Heure', slot)}
          </table>
        </td></tr>
        <tr><td style="padding:22px 30px 6px">
          <p style="color:#555;font-size:14px;line-height:1.5;margin:0">Au plaisir de vous revoir chez Blade Society&nbsp;! Vous pouvez reprendre un rendez-vous quand vous le souhaitez.</p>
        </td></tr>
        <tr><td style="padding:18px 30px 26px" align="center">
          <a href="https://bladesociety.fr" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 24px;border-radius:8px">Reprendre un rendez-vous</a>
        </td></tr>
        <tr><td style="background:#f6f5f2;padding:16px 30px;text-align:center">
          <a href="https://bladesociety.fr" style="color:#9b8a5a;font-size:12px;text-decoration:none;letter-spacing:.04em">bladesociety.fr</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:28px 0">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">
        <tr><td style="background:#0a0a0a;padding:26px 30px;text-align:center">
          <div style="color:#cfc7b3;font-size:22px;letter-spacing:.18em;font-weight:700">BLADE SOCIETY</div>
          <div style="color:#7c776c;font-size:11px;letter-spacing:.22em;margin-top:5px">COIFFEUR · BARBIER</div>
        </td></tr>
        <tr><td style="padding:30px 30px 6px">
          <div style="display:inline-block;background:${(isMod || isReminder) ? '#fff4e6' : '#eef6ee'};color:${(isMod || isReminder) ? '#b26a00' : '#2e7d32'};font-size:13px;font-weight:700;padding:7px 14px;border-radius:20px">${isReminder ? '⏰ Rappel de rendez-vous' : isMod ? '✓ Rendez-vous modifié' : '✓ Rendez-vous confirmé'}</div>
          <p style="color:#1a1a1a;font-size:16px;margin:20px 0 4px">Bonjour ${name},</p>
          <p style="color:#555;font-size:14px;line-height:1.5;margin:0 0 ${isMod ? '8' : '14'}px">${isReminder ? 'Petit rappel&nbsp;: votre rendez-vous est dans environ 4&nbsp;heures&nbsp;:' : isMod ? 'Votre rendez-vous a bien été déplacé. Voici votre nouveau créneau&nbsp;:' : 'Votre rendez-vous est bien enregistré. Voici le récapitulatif&nbsp;:'}</p>
          ${isMod ? `<p style="color:#999;font-size:13px;line-height:1.5;margin:0 0 14px">Ancien créneau&nbsp;: <span style="text-decoration:line-through">${oldDate} · ${oldSlot}</span></p>` : ''}
        </td></tr>
        <tr><td style="padding:0 30px">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee">
            ${row('Prestation', service)}
            ${row('Tarif', price)}
            ${row('Date', date)}
            ${row('Heure', slot)}
          </table>
        </td></tr>
        <tr><td style="padding:22px 30px 0">
          <p style="color:#555;font-size:14px;line-height:1.5;margin:0">📍 44 Avenue Paul Kruger, 69100 Villeurbanne</p>
        </td></tr>
        <tr><td style="padding:18px 30px 6px">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f2;border-left:3px solid #9b8a5a;border-radius:8px">
            <tr><td style="padding:18px 20px">
              <p style="color:#1a1a1a;font-size:15px;font-weight:700;margin:0 0 12px;text-align:center">✨ Salut, c'est Giovany de Blade Society ! ✨</p>
              <p style="color:#444;font-size:14px;line-height:1.5;margin:0 0 10px">📱 À partir de 10&nbsp;min avant l'heure de ton rendez-vous, tu pourras accéder au salon.</p>
              <p style="color:#444;font-size:14px;line-height:1.5;margin:0 0 8px">🧭 Tu devras suivre les étapes suivantes&nbsp;:</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${step(1, '🚦 Rends-toi au niveau du feu rouge, devant le petit portillon gris.')}
                ${step(2, '📞 Interphone en recherchant «&nbsp;Blade Society&nbsp;».')}
                ${step(3, '🏢 Interphone à nouveau au bâtiment A, le premier bâtiment sur ta gauche.')}
                ${step(4, '🛗 Prends l\'ascenseur jusqu\'au 3ᵉ étage, puis ouvre la porte marron en face de toi.')}
                ${step(5, '💈 Le salon est le deuxième bureau à droite. Toque et entre dans le salon.')}
              </table>
              <p style="color:#1a1a1a;font-size:14px;margin:14px 0 0">Merci&nbsp;✌️</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:12px 30px 0" align="center">
          <p style="color:#555;font-size:13px;line-height:1.5;margin:0">Un imprévu ou une question&nbsp;? Appelez Giovany au <a href="tel:+33644164499" style="color:#9b8a5a;font-weight:700;text-decoration:none">06&nbsp;44&nbsp;16&nbsp;44&nbsp;99</a></p>
        </td></tr>
        ${manageUrl ? `<tr><td style="padding:18px 30px 26px" align="center">
          <a href="${manageUrl}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 24px;border-radius:8px">Gérer ou annuler mon rendez-vous</a>
          <p style="color:#999;font-size:12px;line-height:1.5;margin:10px 0 0">Un imprévu&nbsp;? Annule ou déplace ton rendez-vous en un clic, depuis n'importe quel appareil.</p>
        </td></tr>` : `<tr><td style="padding:16px 30px 24px">
          <p style="color:#888;font-size:13px;line-height:1.5;margin:0">Un imprévu&nbsp;? Tu peux annuler ton rendez-vous depuis le site, rubrique «&nbsp;Mes rendez-vous&nbsp;».</p>
        </td></tr>`}
        <tr><td style="background:#f6f5f2;padding:16px 30px;text-align:center">
          <a href="https://bladesociety.fr" style="color:#9b8a5a;font-size:12px;text-decoration:none;letter-spacing:.04em">bladesociety.fr</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

/* ---------- Email client : version TEXTE (multipart -> meilleure délivrabilité) ---------- */
function clientEmailText(b) {
  const name = b.to_name || '';
  const service = b.service || '';
  const price = b.price || '';
  const date = b.date || '';
  const slot = b.slot || '';
  const L = ['BLADE SOCIETY — Coiffeur · Barbier', ''];
  if (b.cancelled) {
    L.push('Bonjour ' + name + ',', 'Votre rendez-vous a bien été annulé.');
    if (service) L.push('Prestation : ' + service);
    if (date) L.push('Date : ' + date);
    if (slot) L.push('Heure : ' + slot);
    L.push('', 'Au plaisir de vous revoir. Reprenez rendez-vous quand vous voulez sur https://bladesociety.fr');
    return L.join('\n');
  }
  const isMod = b.old_date && b.old_slot;
  L.push('Bonjour ' + name + ',', b.reminder ? 'Petit rappel : votre rendez-vous est dans environ 4 heures.' : isMod ? 'Votre rendez-vous a bien été modifié.' : 'Votre rendez-vous est confirmé.');
  if (isMod) L.push('Ancien créneau : ' + b.old_date + ' · ' + b.old_slot);
  if (service) L.push('Prestation : ' + service + (price ? ' (' + price + ')' : ''));
  if (date) L.push('Date : ' + date);
  if (slot) L.push('Heure : ' + slot);
  L.push('', 'Adresse : 44 Avenue Paul Kruger, 69100 Villeurbanne',
    'Accès (10 min avant) : feu rouge / portillon gris, interphone « Blade Society », bâtiment A, ascenseur 3e étage, porte marron, 2e bureau à droite.',
    'Un imprévu ou une question ? Appelez Giovany au 06 44 16 44 99.');
  if (b.manage_url) L.push('', 'Gérer, déplacer ou annuler votre rendez-vous : ' + b.manage_url);
  L.push('', 'À très vite, Giovany — Blade Society', 'https://bladesociety.fr');
  return L.join('\n');
}

/* ---------- Envoi Brevo (partagé : route /email + rappel planifié) ---------- */
function emailSubject(b) {
  if (b.reminder) return 'Rappel : votre rendez-vous dans 4h — Blade Society';
  if (b.cancelled) return 'Votre rendez-vous a été annulé — Blade Society';
  if (b.old_date && b.old_slot) return 'Votre rendez-vous a été modifié — Blade Society';
  return 'Votre rendez-vous chez Blade Society';
}
async function sendBrevoEmail(b, env) {
  return fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      sender: { name: env.SENDER_NAME || 'Blade Society', email: env.SENDER_EMAIL },
      to: [{ email: b.to_email, name: b.to_name || '' }],
      subject: emailSubject(b),
      htmlContent: clientEmailHtml(b),
      textContent: clientEmailText(b),
      replyTo: { email: env.SENDER_EMAIL, name: env.SENDER_NAME || 'Blade Society' },
    }),
  });
}

/* ---------- Rappel de RDV : date/heure FR + heure de Paris ---------- */
const DOW_FR = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MON_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function prettyDateFR(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return DOW_FR[dt.getUTCDay()] + ' ' + d + ' ' + MON_FR[m - 1] + ' ' + y;
}
function frTimeFR(t) { const p = String(t).split(':'); return p[0] + 'h' + p[1]; }
function parisNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = {}; for (const x of parts) p[x.type] = x.value;
  let hh = parseInt(p.hour, 10); if (hh === 24) hh = 0;
  return { date: p.year + '-' + p.month + '-' + p.day, minutes: hh * 60 + parseInt(p.minute, 10) };
}

/* ---------- Rappels automatiques : appelé par le Cron Trigger ---------- */
async function sendReminders(env) {
  if (!env.BREVO_API_KEY || !env.FIREBASE_DB_URL) return;
  let slots = {};
  try {
    const r = await fetch(env.FIREBASE_DB_URL.replace(/\/$/, '') + '/slots.json');
    slots = (await r.json()) || {};
  } catch (e) { return; }
  const contacts   = JSON.parse((await env.SUBS.get('contacts'))   || '{}');
  const reminded   = JSON.parse((await env.SUBS.get('reminded'))   || '{}');  // email ~4h avant
  const reminded24 = JSON.parse((await env.SUBS.get('reminded24')) || '{}');  // SMS   ~24h avant
  const now = parisNow();
  const site = (env.SITE_URL || 'https://bladesociety.fr').replace(/\/$/, '') + '/';
  let changed = false, changed24 = false;
  for (const key in slots) {
    const sl = slots[key];
    if (!sl || sl.blocked) continue;
    const us = key.indexOf('_');
    if (us < 0) continue;
    const date = key.slice(0, us), time = key.slice(us + 1);
    const gap = dayGap(now.date, date);
    if (gap < 0 || gap > 1) continue;                      // seuls aujourd'hui et demain nous intéressent
    const tp = time.split(':');
    const apptMin = parseInt(tp[0], 10) * 60 + parseInt(tp[1], 10);
    const minsUntil = gap * 1440 + apptMin - now.minutes;  // minutes avant le RDV
    const c = contacts[key];
    if (!c) continue;

    /* --- rappel EMAIL ~4h avant (le Cron passe toutes les 10 min) --- */
    if (minsUntil >= 230 && minsUntil <= 250 && !reminded[key] && c.email && env.SENDER_EMAIL) {
      const manageUrl = site + '?rdv=' + encodeURIComponent(key) + '&t=' + encodeURIComponent(sl.tok || '')
        + '&e=' + encodeURIComponent(c.email) + '&p=' + encodeURIComponent(c.phone || '');
      const b = {
        to_email: c.email, to_name: c.name || sl.name || '',
        service: sl.service || '', price: sl.price || '',
        date: prettyDateFR(date), slot: frTimeFR(time),
        reminder: true, manage_url: manageUrl,
      };
      try { await sendBrevoEmail(b, env); reminded[key] = true; changed = true; } catch (e) {}
    }

    /* --- rappel SMS ~24h avant (texte sans accents = 1 seul SMS facturé) --- */
    if (minsUntil >= 1430 && minsUntil <= 1450 && !reminded24[key] && c.phone && env.SMS_SENDER) {
      const d = date.split('-');
      const content = 'Blade Society\n'
        + 'Rappel : votre RDV est demain ' + d[2] + '/' + d[1] + ' a ' + frTimeFR(time) + '.\n'
        + 'Modification ou annulation : lien dans votre email.\n'
        + 'A bientot !';
      const r = await sendBrevoSms(c.phone, content, env);
      if (r.ok) { reminded24[key] = true; changed24 = true; }
    }
  }
  for (const k in reminded) {                              // purge des clés passées
    const d = k.slice(0, k.indexOf('_'));
    if (d && d < now.date) { delete reminded[k]; changed = true; }
  }
  for (const k in reminded24) {
    const d = k.slice(0, k.indexOf('_'));
    if (d && d < now.date) { delete reminded24[k]; changed24 = true; }
  }
  if (changed)   await env.SUBS.put('reminded',   JSON.stringify(reminded));
  if (changed24) await env.SUBS.put('reminded24', JSON.stringify(reminded24));
}

/* ---------- Cloudinary (upload signé : le secret reste dans le Worker) ---------- */
async function sha1hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function cloudinaryUpload(fileDataUri, env) {
  const ts = Math.floor(Date.now() / 1000);
  const folder = 'blade-society';
  const signature = await sha1hex(`folder=${folder}&timestamp=${ts}` + env.CLOUDINARY_SECRET);
  const form = new FormData();
  form.append('file', fileDataUri);            // data:image/...;base64,... (accepté par Cloudinary)
  form.append('api_key', env.CLOUDINARY_KEY);
  form.append('timestamp', String(ts));
  form.append('folder', folder);
  form.append('signature', signature);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/image/upload`, { method: 'POST', body: form });
  try { return await r.json(); } catch (e) { return null; }
}
async function cloudinaryDestroy(publicId, env) {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const signature = await sha1hex(`public_id=${publicId}&timestamp=${ts}` + env.CLOUDINARY_SECRET);
    const form = new FormData();
    form.append('public_id', publicId);
    form.append('api_key', env.CLOUDINARY_KEY);
    form.append('timestamp', String(ts));
    form.append('signature', signature);
    await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/image/destroy`, { method: 'POST', body: form });
  } catch (e) {}
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
      'Urgency': 'high',                       // livraison prioritaire (réduit le délai iOS)
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC,
    },
    body: bodyBytes,
  });
}
