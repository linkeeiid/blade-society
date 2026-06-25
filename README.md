# Blade Society — site barbershop

Site vitrine + réservation en ligne pour **Blade Society** (Villeurbanne).
Site statique : un seul fichier `index.html`, aucune dépendance, aucun build.

## Lancer
Ouvrir `index.html` dans un navigateur, ou servir le dossier :
```
npx serve .
```

## Structure
```
blade-society/
├─ index.html          ← tout le site (HTML + CSS + JS)
├─ assets/
│  ├─ logo-fondu.png   ← logo nav / footer (fond fondu)
│  └─ logo.png         ← logo plein
└─ README.md
```

## Configuration (bloc `CFG` en haut du `<script>` dans index.html)
- **TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID** — notification instantanée à chaque réservation
  (bot via @BotFather, chat_id via @userinfobot).
- **FIREBASE_DB_URL** — Realtime Database gratuite pour partager les réservations entre
  appareils. Sans ça, les réservations restent stockées localement (localStorage) par appareil.
- **EMAILJS_*** — secours email (optionnel).
- **BARBER_PASSWORD** — accès à l'« Espace barber » (par défaut `GiovanyBlade`).
  Bouton « // Espace barber » en bas de la section Réservation → liste des RDV, annulation.

## Notes
- Créneaux : Lun–Sam, 9 horaires (10h→19h, pause 13h-14h), séances de 45 min, dimanche fermé.
- Les emplacements « Portrait » et la galerie sont prêts à recevoir de vraies photos.
- Adapté du design Claude Design « Blade Society.dc.html » (thème par défaut :
  accent Bronze, fond Noir absolu, titres Anton).
