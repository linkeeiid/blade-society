# Notifications push — déploiement du Worker Cloudflare

Objectif : un petit serveur gratuit qui envoie la notif sur l'iPhone de Giovany à chaque réservation.

## Les valeurs à utiliser
- **VAPID_PUBLIC** (publique) :
  `BB4WXyAbUQOZasrJVcQtBXRnh9iWNTB8OQV6LWAI6WfdeO7yDJjr9OWjXQrddxm60rAqoiVtZNjfk7gTBwI4Moc`
- **VAPID_PRIVATE** (secrète) : voir le fichier `VAPID-KEYS.txt` (ne JAMAIS la publier).
- **VAPID_SUBJECT** : `mailto:etudes.rg@gmail.com`

## Étapes (dashboard Cloudflare)

### 1. Créer le Worker
1. **dash.cloudflare.com** → menu **Workers & Pages** → **Create** → **Create Worker**.
2. Nom : **blade-society-push** → **Deploy**.
3. **Edit code** → efface tout → colle le contenu de **`cloudflare-worker.js`** → **Deploy**.

### 2. Créer le stockage (KV)
4. Menu **Workers & Pages** → **KV** → **Create a namespace** → nom **blade-society-subs** → **Add**.

### 3. Brancher le KV au Worker
5. Ouvre le Worker **blade-society-push** → **Settings** → **Bindings** (ou **Variables**).
6. **KV Namespace Bindings** → **Add binding** :
   - Variable name : **SUBS**
   - Namespace : **blade-society-subs**
   - **Save / Deploy**

### 4. Ajouter les variables
7. Toujours dans **Settings → Variables (Environment Variables)** → **Add variable** :
   - `VAPID_PUBLIC`  = la clé publique ci-dessus  (texte normal)
   - `VAPID_SUBJECT` = `mailto:etudes.rg@gmail.com`  (texte normal)
   - `VAPID_PRIVATE` = la clé privée (de `VAPID-KEYS.txt`) → clique **Encrypt** (secret)
   - **Save and deploy**

### 5. Récupérer l'adresse du Worker
8. En haut du Worker, copie son URL, du type :
   `https://blade-society-push.TON-SOUS-DOMAINE.workers.dev`
9. **Donne-moi cette URL** → je la colle dans le site (`CFG.PUSH_ENDPOINT`) et on teste.

## Test final
1. Sur l'iPhone de Giovany : ouvre **l'app installée** (écran d'accueil) → Espace barber → **« Activer les notifications »** → Autoriser.
2. Depuis un autre téléphone, fais une **réservation test**.
3. L'iPhone de Giovany doit recevoir la notif **« Blade Society — nouvelle réservation … »**. ✅
