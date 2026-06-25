# Mettre le site Blade Society en ligne (GitHub Pages) — gratuit

## Une seule fois : publier le site

### 1. Créer un compte GitHub
- Va sur **github.com** → « Sign up » → crée un compte (gratuit).

### 2. Installer GitHub Desktop
- Va sur **desktop.github.com** → télécharge et installe **GitHub Desktop**.
- Ouvre-le → connecte-toi avec ton compte GitHub.

### 3. Ajouter le dossier du site
- Dans GitHub Desktop : menu **File → Add local repository**.
- Choisis le dossier : `Documents\CLAUDE WEBSITE\blade-society`
- S'il dit « this isn't a Git repository », clique **« create a repository »** → **Create Repository**.

### 4. Publier sur GitHub
- Clique le gros bouton **« Publish repository »** (en haut à droite).
- Nom : `blade-society`
- ⚠️ **DÉCOCHE** « Keep this code private » (le site doit être public pour GitHub Pages gratuit).
- Clique **Publish Repository**.

### 5. Activer GitHub Pages
- Va sur **github.com** → ton dépôt `blade-society` → onglet **Settings**.
- Menu de gauche → **Pages**.
- « Source » → **Deploy from a branch** → Branch : **main** → dossier **/ (root)** → **Save**.
- Attends ~1 minute, recharge : une adresse apparaît en haut, type :
  `https://ton-pseudo.github.io/blade-society/`
- 🎉 Le site est EN LIGNE, visible par tous.

---

## À chaque fois que tu veux modifier le site

1. Les fichiers sont modifiés (par toi ou avec l'aide de Claude) dans le dossier `blade-society`.
2. Ouvre **GitHub Desktop** → il affiche tout seul les fichiers changés (à gauche).
3. En bas à gauche : écris un petit résumé (ex. « Changement tarif coupe »).
4. Clique **« Commit to main »**.
5. En haut : clique **« Push origin »**.
6. Attends ~1 minute → le site en ligne est mis à jour. ✅

> Tu peux modifier **autant de fois que tu veux**, gratuitement. Le site n'est jamais figé.

### Modifier un petit texte sans GitHub Desktop (option rapide)
- Sur **github.com** → ton dépôt → ouvre `index.html` → icône **crayon** ✏️ → modifie → **Commit changes**.
- Le site se met à jour automatiquement.

---

## Plus tard (optionnel)
- **Nom de domaine** (`bladesociety.fr`, ~10 €/an) : achetable chez OVH / Namecheap / Hostinger, puis on le « pointe » vers GitHub Pages (Settings → Pages → Custom domain).
- **Notifications Telegram**, **emails clients** : à brancher une fois en ligne.
