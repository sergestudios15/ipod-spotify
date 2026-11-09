# iPod Spotify

Télécommande Spotify façon iPod classique. C'est une web app installable (PWA) : un seul lien pour iPhone, iPad, Android et Galaxy Tab, sans App Store.

## Fonctions
- Molette tactile : tourner pour défiler, MENU = retour, ⏮ ⏭ ⏯, bouton central = valider.
- Playlists, artistes suivis, albums enregistrés, titres likés, écoutés récemment, recherche (artistes, albums, titres, playlists).
- Écran « En cours » : pochette, progression, volume à la molette, options (j'aime, aléatoire, répéter, aller à l'artiste ou à l'album).
- Choix de l'appareil de lecture (téléphone, enceinte, PC…).
- Jam : ouvre Spotify pour le lancer, car l'API Spotify ne permet pas de démarrer un Jam depuis une autre app. Une fois lancé, l'iPod le pilote.
- Personnalisation : 8 thèmes prêts, 11 parties réglables une par une, 3 finitions, thèmes enregistrés.
- Mode démo sans compte : ajouter `?demo` à l'adresse.

## Mise en route (une seule fois)
1. developer.spotify.com/dashboard → **Create app**.
2. Redirect URI : l'adresse exacte de l'app (ex. `https://sergestudios15.github.io/ipod-spotify/`). Cocher **Web API**.
3. Copier le **Client ID** dans `config.js` (ce n'est pas un secret).
4. **User Management** : ajouter l'email Spotify de chaque utilisatrice ou utilisateur (mode développement de Spotify).
5. Il faut **Spotify Premium** pour piloter la lecture.

## Installer sur l'écran d'accueil
- iPhone / iPad : ouvrir le lien dans **Safari** → Partager → **Sur l'écran d'accueil**.
- Android / Galaxy Tab : ouvrir dans **Chrome** → ⋮ → **Installer l'application**.

## Test en local
```
node tools/serve.js
```
Puis ouvrir http://127.0.0.1:5173/ (ajouter aussi `http://127.0.0.1:5173/` comme Redirect URI dans Spotify).
