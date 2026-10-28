# Word Chain

Jeu Node.js, Express et Socket.IO pour 1 à 8 personnes par room. Sauvegarde PostgreSQL (Neon), administration sur `/admin`.

## Installation et environnement

```sh
npm install
npm run dev
```

Copier `.env.example` vers `.env` si le fichier n'existe pas, puis renseigner :

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DB?sslmode=require
ADMIN_USERNAME=admin
ADMIN_PASSWORD=un-mot-de-passe-long-unique-et-prive
TRUST_PROXY=0
PORT=3000
```

Utiliser la connexion PostgreSQL poolée fournie par Neon, avec TLS, sans désactiver la validation des certificats dans le code. Ne jamais publier cette URL ou le mot de passe. `.env` est ignoré par Git ; `.env.example` est un modèle sans secret. Node charge `.env` au lancement. Les variables Render existantes restent prioritaires.

Le jeu est sur http://localhost:3000 et l'administration sur http://localhost:3000/admin. `npm start` lance sans surveillance des fichiers.

## Sauvegarde PostgreSQL

Lorsque `DATABASE_URL` est renseigné, le serveur crée automatiquement `wcg_rooms` (état et archives des rooms en JSONB) et `wcg_events` (événements de fonctionnement) ainsi que leurs index. Le compte PostgreSQL doit pouvoir créer et modifier ces tables. Le serveur charge les rooms avant d'accepter les connexions.

Les écritures des rooms sont sérialisées et transactionnelles. Seules les rooms modifiées sont réécrites ; les rooms expirées sont supprimées. Les confirmations Socket.IO attendent la sauvegarde PostgreSQL. En cas d'échec, le client reçoit une erreur, l'état en mémoire reste disponible pour une nouvelle tentative et le contrôle `/healthz` signale la dégradation. Une panne de base n'active jamais une sauvegarde JSON de secours en production.

L'état des parties et la présence restent en mémoire pour les minuteurs : conserver **une seule instance** du serveur. Neon sauvegarde durablement les rooms après les mises en veille ou redéploiements Render ; il ne rend pas le serveur gratuit continuellement disponible. Les deux offres gratuites restent soumises à leurs quotas.

Sans `DATABASE_URL`, le développement local utilise `data/rooms.json` (ou `ROOMS_FILE`) ; les statistiques de développement sont alors uniquement en mémoire. En production, `DATABASE_URL` est obligatoire.

### Importer les anciennes rooms JSON

Sauvegarder le fichier JSON existant, arrêter temporairement le jeu pour éviter des écritures concurrentes, puis exécuter avec `DATABASE_URL` configuré :

```sh
npm run import:rooms -- data/rooms.json
```

L'import ajoute les codes absents, sans écraser les rooms déjà présentes en base. Redémarrer ensuite le serveur pour charger les rooms importées. Le déploiement ne transfère pas automatiquement les rooms locales ou l'ancien fichier Render.

## Administration et statistiques

`/admin` propose un tableau de bord avec :

- Connexions actives, navigateurs uniques, rooms actives, parties lancées/terminées, mots acceptés/refusés et erreurs.
- Courbes quotidiennes sur aujourd'hui, 7 ou 30 jours (jours UTC), répartition des connexions par pays.
- Visiteurs actuellement connectés, pseudos lorsqu'ils rejoignent une room, 100 dernières connexions et rooms conservées.
- Durée moyenne des sessions terminées, mémoire et durée de fonctionnement du processus, état du stockage.

Configurer `ADMIN_PASSWORD` avec **au moins 16 caractères** ; sinon les API admin restent désactivées. `ADMIN_USERNAME` vaut `admin` par défaut. La session dure 8 heures et utilise un cookie HttpOnly, SameSite=Strict, Secure en production. La déconnexion invalide la session. Les tentatives de connexion sont limitées et les requêtes d'origine différente sont refusées. Les sessions sont effacées au redémarrage.

Le client transmet son identifiant de navigateur existant à Socket.IO. Les statistiques démarrent avec cette version : aucune visite antérieure n'est reconstruite. Un navigateur unique n'est pas une personne vérifiée et peut être réinitialisé. Une reconnexion réseau compte comme une connexion supplémentaire.

Les pays sont estimés en arrière-plan avec l’API HTTPS gratuite `ipwho.is`, sans clé : https://ipwhois.io/documentation. Elle reçoit uniquement l’IP publique recherchée. Le jeu ne l’attend pas : le pays local est affiché immédiatement, puis enrichi dans les connexions et les graphiques après la réponse. Le cache en mémoire dure 24 heures, est limité à 2 000 entrées et utilise des clés HMAC avec un sel aléatoire non persistant ; aucune IP brute n’est conservée dans la base. Les requêtes simultanées pour la même IP sont regroupées. Les IP locales, privées et réservées ne sont jamais envoyées. Un délai de 5 secondes, quatre requêtes simultanées maximum, un plafond local de 900 appels par jour UTC et une pause respectant `Retry-After` protègent les quotas. Ce compteur local repart au redémarrage ; le quota du fournisseur peut être partagé par plusieurs serveurs derrière la même IP. En cas de panne, réponse invalide ou quota dépassé, la base locale GeoLite/MaxMind sert de secours avec un cache de 5 minutes. `GEOIP_API_ENABLED=0` désactive les appels externes ; par défaut la fonction est active. Le cache est perdu au redémarrage, les anciens pays sans IP ne peuvent pas être recalculés. Une IP inconnue donne « Pays inconnu » et un VPN peut modifier le résultat. Une notice utilisateur est disponible sur `/privacy.html`.

Sur Render, `TRUST_PROXY=1` recherche la première adresse publique valide dans `X-Forwarded-For` pour la géolocalisation, au lieu de confondre le dernier relais interne avec le visiteur. Cette estimation ne sert pas à authentifier ni limiter les connexions admin. Si `TRUST_PROXY` est absent, Render est détecté avec `RENDER=true` ; une valeur explicite `0` désactive cette lecture. En local sans proxy, laisser `0` pour ignorer les en-têtes forgés. Ne pas exposer directement un serveur configuré pour faire confiance au proxy. Les événements sont purgés après 30 jours au démarrage et toutes les heures pendant le fonctionnement ; les tableaux admin filtrent également la période.

## Déployer la mise à jour sur Render

`render.yaml` est prévu pour un **service gratuit**, une instance à Francfort, avec une base PostgreSQL externe. Aucun disque persistant n'est nécessaire.

Pour le service déjà en ligne, ajouter dans **Environment** avant de redéployer :

```env
DATABASE_URL=la-connexion-neon-avec-TLS
ADMIN_USERNAME=admin
ADMIN_PASSWORD=un-mot-de-passe-long-unique-et-prive
TRUST_PROXY=1
NODE_ENV=production
```

L'ancienne variable `ROOMS_FILE` n'est plus utilisée lorsque `DATABASE_URL` est défini. Retirer tout ancien disque/offre payante uniquement après avoir exporté et importé les rooms à conserver ; le fichier Blueprint ne migre pas un service manuel automatiquement.

Le build lance `npm ci --include=dev`, les tests, puis `npm prune --omit=dev`. Le démarrage est `npm start`, le contrôle de santé `/healthz`. Après publication, vérifier le jeu, créer une room, redéployer et rejoindre le même code. L'administration sera disponible sur `https://web-wordchain.onrender.com/admin`. Ne pas coller les secrets dans le chat ou dans Git.

Références : https://neon.com/docs/connect/connect-from-any-app et https://render.com/docs/free.

## Règles WCG

Le serveur tire une nouvelle initiale à chaque tour parmi les 12 initiales offrant le plus de mots admissibles dans le dictionnaire FR/EN, selon la longueur demandée. Les initiales sans mot encore disponible sont exclues et les répétitions consécutives évitées lorsqu'une alternative existe. La dernière lettre du mot joué n'impose plus la suivante.

Chaque joueur dispose de 15 secondes. Le minimum est de 3 lettres au premier tour complet, puis 4… jusqu'à 10 lettres minimum (limite technique : 40). Accents, casse et ligatures œ/æ sont normalisés ; les doublons sont interdits. Un mot valide rapporte sa longueur normalisée. Un mot refusé ne remet pas le minuteur à zéro.

À l'échéance, le joueur est éliminé pour toute la partie. Il conserve ses points, regarde les autres et ne réintègre pas la rotation en se reconnectant. Le dernier joueur continue jusqu'à son échec ; les résultats sont alors archivés automatiquement. L'hôte peut aussi terminer manuellement. Les victoires restent attribuées au meilleur score positif en multijoueur, ex æquo compris ; les parties solo comptent pour les points et parties, sans victoire.

Les participants sont fixés au lancement. Les nouveaux arrivants restent spectateurs jusqu'à la prochaine partie, qui les inclut automatiquement. Les participants non éliminés peuvent revenir. Sans participant encore en lice connecté, la partie et le temps restant sont en pause. Revenir ne redonne ni 15 secondes ni une nouvelle lettre pour le même tour. Le créateur est l'hôte lorsqu'il est présent ; sinon le premier connecté prend ce rôle.

Une room expire après 7 jours sans présence ; le code `/room/ABCDEF` (et l'ancien `/?room=ABCDEF`) reste réutilisable jusque-là. Les scores en cours sont dans la barre latérale de « Jouer », les archives dans « Classement & historique ».

Le serveur fixe échéance, initiale, longueur et identifiant de tour. Les horodatages client sont ignorés ; une réponse reçue à partir de l'échéance est refusée. Le navigateur affiche un décompte monotone synchronisé, avec estimation du délai réseau.

## Tests

```sh
npm test
```

Les tests isolent leurs données et n'utilisent jamais la variable `DATABASE_URL` pour se connecter à une base externe. La logique PostgreSQL est testée via `pg-mem`, les API admin via HTTP, et le jeu via Socket.IO. Une vérification avec la vraie connexion Neon reste nécessaire au déploiement.

### Tester les pays en local

`localhost` donne généralement `127.0.0.1` ou `::1` ; un accès depuis le Wi-Fi local peut donner une IP privée `192.168.x.x`. Ces adresses n’ont pas de pays et ne sont pas envoyées à l’API. Les nouvelles connexions correspondantes portent la mention « Adresse non publique » dans l’admin. Cela ne remet pas en cause la recherche pour les visiteurs publics. Sur Render, régler `TRUST_PROXY=1` et `GEOIP_API_ENABLED=1`, puis tester une nouvelle connexion après redéploiement. Les anciennes connexions sans IP conservée ne peuvent pas être corrigées rétroactivement. L’admin se rafraîchit toutes les 30 secondes et l’enrichissement API reste asynchrone.

Si Render affiche des adresses non publiques pour des visiteurs distants, vérifier dans l’admin les indicateurs « Proxy actif » et « API active ». `IP visiteur indisponible` signifie qu’aucune adresse publique n’a pu être extraite malgré le proxy activé. Les anciens enregistrements ne sont pas corrigibles sans leurs anciennes IP, qui ne sont pas conservées ; les nouvelles connexions utilisent la correction.

## Bruitages

Le jeu synthétise ses sons avec Web Audio (`public/sounds.js`) : début de partie/tour, mot validé/refusé, ticks à 5/3/1 secondes, élimination et fin de partie (avec une courte variation pour une victoire). Aucun fichier à télécharger ni service externe. Les bruitages sont originaux, sans dépendance à une banque audio.

Le navigateur n'initialise le son qu'après un clic, un toucher ou une touche clavier. Le bouton de l'en-tête coupe les bruitages immédiatement ; le volume reste modéré et plafonné à 60 %. Activation et volume sont conservés dans localStorage (`wordchain-audio`). Si Web Audio n'est pas disponible, le jeu reste utilisable sans son. Pas de musique en boucle.

Les ticks ne concernent que le joueur actif, un seul à chaque seuil. Les mises à jour répétées et les reconnexions ne rejouent pas les anciens événements. Une seule séquence joue à la fois et les sons sont arrêtés quand l'onglet est masqué, à la déconnexion ou au départ de la room. La synthèse est testée avec un contexte audio simulé ; l'écoute finale et les particularités des navigateurs mobiles se vérifient dans le navigateur.

## Formatage

Prettier est installé comme dépendance de développement avec une version exacte. `npm run format` formate le projet et `npm run format:check` vérifie son formatage. Les dictionnaires, les données locales, les fichiers d’environnement et les fichiers générés sont exclus via `.prettierignore`.

## Discussion vocale WebRTC

Le micro reste facultatif : « Activer mon micro » ou « Écouter ». Chaque navigateur ouvre au plus sept connexions audio pour une room de huit. Socket.IO transporte uniquement la signalisation et les commandes. Le mute de l’hôte est conservé par identité dans la room ; tous les clients coupent la voix ciblée, et lever le mute ne rallume jamais automatiquement son micro. Le blocage personnel et l’écoute coupée restent locaux. Le navigateur arrête le micro à la sortie du vocal/de la room et à la perte de connexion au serveur. Aucun enregistrement audio.

### Configuration sur Render

HTTPS est obligatoire hors localhost. Render héberge la signalisation existante, pas le relais UDP. Ajouter dans Environment :

- `WEBRTC_STUN_URLS` : `stun:stun.l.google.com:19302` (défaut).
- `TURN_URLS` : URLs fournies par un service TURN ou votre Coturn, par exemple `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp`.
- `TURN_SHARED_SECRET` : secret Coturn `static-auth-secret` avec `use-auth-secret`. Le serveur génère des identifiants temporaires HMAC valables une heure et le client les renouvelle ; le secret reste sur le serveur.
- Alternative pour un fournisseur acceptant des identifiants fixes : `TURN_USERNAME` et `TURN_CREDENTIAL`, en laissant `TURN_SHARED_SECRET` vide. Ces identifiants seront transmis aux participants du vocal ; préférer des identifiants temporaires.
- `WEBRTC_RELAY_ONLY=1` force l’audio via TURN pour éviter l’échange des IP publiques entre participants. Sans TURN configuré, ce mode refuse l’ouverture du vocal.

Le STUN seul permet des connexions directes mais ne suffit pas sur certains réseaux mobiles, d’entreprise ou derrière des NAT restrictifs. Ne pas exposer un relais TURN sans authentification. Les clés TURN ne vont jamais dans `public/` ni dans Git. Les variables vides de `.env.example` sont à renseigner localement ou dans Render ; aucun service TURN n’est créé automatiquement.

### Vérification avant utilisation publique

Ouvrir deux navigateurs avec des identités distinctes dans la même room, autoriser le micro et vérifier la parole dans les deux sens (casques conseillés). Tester écoute seule, mute personnel, blocage individuel, mute par l’hôte, changement d’hôte, sortie de room et reconnexion. Tester ensuite sur deux réseaux distincts (Wi-Fi/mobile) avec `WEBRTC_RELAY_ONLY=1` pour vérifier réellement les identifiants, le certificat et les ports du relais. `chrome://webrtc-internals` ou `about:webrtc` permet de confirmer une paire ICE de type `relay`. Les tests automatisés couvrent les permissions, la signalisation et le cycle de vie mais ne remplacent pas ce test audio réel.

Test WebRTC dans de vrais navigateurs, avec des micros simulés : `npm run test:voice:browser`. Il faut Chrome ou Edge installé (chemin personnalisable avec `VOICE_BROWSER_PATH`). Ce test vérifie les paquets audio bidirectionnels, une room à trois avec spectateur, l’activation depuis l’écoute seule, les différents mutes, la reconnexion et la reprise de modération par le membre présent depuis le plus longtemps. Il est distinct de `npm test` pour que le build Render ne dépende pas d’un navigateur.
