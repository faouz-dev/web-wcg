# Word Chain

Jeu web Node.js, Express et Socket.IO pour 1 à 8 personnes par room.

## Démarrer

```sh
npm install
npm run dev
```

Ouvrir http://localhost:3000. `npm start` lance le serveur sans surveillance des fichiers. Variables facultatives : `PORT` et `ROOMS_FILE` (par défaut `data/rooms.json`).

## Règles actuelles

Chaque joueur dispose de 15 secondes. Le serveur tire une nouvelle initiale à chaque tour, y compris au premier tour. Il sélectionne uniformément parmi les 12 initiales offrant le plus de mots admissibles dans le dictionnaire français ou anglais, selon la longueur minimale demandée. Il exclut les initiales sans mot encore disponible et évite deux tirages identiques consécutifs lorsqu'une alternative existe. La dernière lettre du mot joué n'impose plus la suivante.

Le minimum est de 3 lettres au premier tour complet, puis 4, 5… jusqu'à 10 lettres minimum. Les mots plus longs restent autorisés (limite technique : 40 lettres normalisées). Les accents, la casse et les ligatures œ/æ sont normalisés. Un mot déjà joué dans la partie est interdit. Un mot valide rapporte autant de points que de lettres normalisées ; un mot refusé ne remet pas le minuteur à zéro.

Au terme des 15 secondes, le joueur est éliminé pour toute la partie. Ses points restent visibles, il regarde les autres jouer et ne réintègre pas la rotation en se reconnectant. Le dernier joueur continue seul jusqu'à son propre échec. Lorsque tous les participants sont éliminés, la partie se termine et les résultats sont archivés automatiquement. L'hôte peut également terminer manuellement.

Le classement cumule les parties terminées. Les victoires restent attribuées au meilleur score positif en multijoueur, avec tous les ex æquo gagnants. Les parties solo comptent pour les points et parties jouées, sans victoire. Une partie n'est archivée qu'une fois.

## Rooms, présence et spectateurs

Le code et le lien `/room/ABCDEF` restent utilisables après le départ des joueurs et le redémarrage du serveur. Les anciens liens `/?room=ABCDEF` fonctionnent également. Une room expire après 7 jours consécutifs sans présence. Le serveur entretient la présence chaque minute, à chaque action et au départ. Les rooms expirées sont purgées au démarrage, chaque minute et lors des tentatives de connexion.

La liste de participants est fixée au lancement. Un nouvel arrivant regarde la partie en cours et est inclus automatiquement au lancement de la suivante. Les participants non éliminés peuvent revenir dans leur partie. Les absents et les éliminés sont ignorés pour les tours. Les scores en cours sont dans la barre latérale de « Jouer » ; le classement cumulé et les archives sont dans « Classement & historique ».

Sans participant encore en lice connecté, la partie et le temps restant sont en pause, même avec des spectateurs présents. Revenir ne redonne pas 15 secondes et ne tire pas une nouvelle lettre pour le même tour. Après un redémarrage, la partie reste en pause jusqu'au retour d'un participant ; une ancienne échéance dépassée provoque l'élimination à la reprise. Le créateur est l'hôte lorsqu'il est présent, sinon le premier joueur connecté prend ce rôle.

## Persistance et horloge

La base JSON est créée automatiquement et ignorée par Git. Les écritures remplacent le fichier via un fichier temporaire. Une base illisible provoque une erreur de démarrage au lieu d'effacer les données. Cette base est prévue pour un seul processus serveur sur un disque persistant ; plusieurs instances nécessiteraient une base partagée.

Le navigateur conserve une identité privée et le pseudo dans localStorage. Modifier le pseudo conserve les statistiques ; supprimer les données du navigateur ou changer d'appareil crée une nouvelle identité. Les dernières rooms visitées sont proposées sur l'accueil.

Le serveur fixe l'échéance, l'initiale, la longueur minimale et l'identifiant de chaque tour. Il élimine automatiquement et refuse les réponses hors tour, anciennes ou reçues à partir de l'échéance. Les horodatages du client n'ont aucune autorité. Le navigateur affiche un décompte monotone synchronisé avec une estimation du délai réseau, à la connexion, toutes les 20 secondes et au retour sur l'onglet.

## Vérifier

```sh
npm test
```

Les tests utilisent des bases temporaires : parcours du pseudo, rooms et spectateurs, persistance, expiration, rotations, tirages FR/EN sur les vrais dictionnaires, accents, doublons, délais et éliminations.

## Déployer sur Render

La configuration est dans `render.yaml` : service Node.js 24, une instance à Francfort, plan payant `0.5c-512mb`, disque persistant de 1 Go monté sur `/var/data`, base JSON dans `/var/data/wordchain/rooms.json` et contrôle de santé `/healthz`. Aucun service n'est créé par la simple présence de ce fichier.

1. Placer ce projet dans un dépôt GitHub ou GitLab avec `wordList/`, les sources, `package-lock.json` et `render.yaml`. Ne pas envoyer `node_modules/`, les secrets ou la base locale `data/`.
2. Dans Render, choisir **New → Blueprint**, connecter le dépôt et vérifier l'offre payante ainsi que le disque avant création.
3. Lancer le déploiement. La construction exécute `npm ci --include=dev`, les tests puis retire les dépendances de développement. Render démarre le jeu avec `npm start`.
4. Ouvrir l'adresse HTTPS fournie par Render. Créer une room, copier son lien `/room/ABCDEF` et tester avec un autre navigateur.
5. Redéployer puis rejoindre le même code pour vérifier la persistance. Les rooms de développement ne sont pas transférées automatiquement.

Les mises à jour de la branche déployée déclenchent un nouveau déploiement. Conserver une seule instance : le JSON et la présence Socket.IO ne sont pas partagés entre plusieurs processus. Le disque doit rester attaché pour préserver les rooms et leurs historiques.

Documentation : https://render.com/docs/blueprint-spec et https://render.com/docs/disks.
