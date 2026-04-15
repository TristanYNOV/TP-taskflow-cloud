# Audit TP5 — Partie 2 (Stress test k6)

_Date de l’audit : 2026-04-14_

## 1) Inventaire des éléments utiles

### 1.1 Scripts k6 présents dans `/scripts`

Fichiers présents :

- `scripts/load-test-light.js`
- `scripts/load-test-realistic.js`

Fichier **absent** alors qu’attendu par certains textes :

- `scripts/load-test.js`

Constats rapides :

- `load-test-light.js` contient un scénario léger (`vus: 5`, `duration: '30s'`) et cible `GET /api/tasks`.
- `load-test-realistic.js` contient un scénario en `stages` (10 → 50 VUs), simule un parcours login + tasks + notifications.
- Les deux scripts utilisent par défaut `BASE_URL=http://localhost:3004` (port Grafana), ce qui est incohérent pour appeler l’API Gateway (port 3000).

---

### 1.2 Commandes npm existantes liées à l’infra / tests

Depuis le `package.json` racine :

- Infra / démarrage :
  - `npm run dev:infra` → `docker compose -f docker-compose.infra.yml up -d`
  - `npm run dev` → `docker compose up --build`
- Installation :
  - `npm run install:all`
- Qualité / tests :
  - `npm run test` (workspaces)
  - `npm run test:gateway`, `test:user`, `test:task`, `test:notification`
  - `npm run lint` + déclinaisons par service

Remarque : aucune commande npm dédiée à k6 n’est définie (ex: `test:load:*`). L’exécution k6 se fait en CLI directe.

---

### 1.3 `docker-compose.yml` et contraintes de scaling

Points structurants observés :

- `task-service` expose un mapping host fixe `"3002:3002"`.
- Le scaling `--scale task-service=3` provoquera un conflit de ports publiés sur l’hôte (un seul conteneur peut binder `3002` côté host).
- Même logique potentielle pour `user-service` et `notification-service` (ports host statiques).
- `api-gateway` dépend du nom de service `task-service` (DNS Compose), mais pas d’une découverte fine d’instances.

Conclusion : la config actuelle est adaptée au dev mono-instance, pas au scaling local propre multi-réplicas avec exposition directe de chaque instance.

---

### 1.4 Configuration Prometheus

Fichier : `infra/prometheus/prometheus.yml`

- Scrape statique (`static_configs`) pour chaque service applicatif.
- Target unique pour `task-service` : `task-service:3002`.
- Donc même avec plusieurs réplicas, Prometheus ne découvre pas automatiquement des instances distinctes via cette config.

Conséquence attendue pour la question 7 : nombre de targets `task-service` probablement inchangé (1 job/target logique visible) malgré `--scale`.

---

### 1.5 Grafana dashboards / provisioning

Présence confirmée :

- Provisioning datasources : `infra/grafana/provisioning/datasources/datasources.yml`
- Provisioning dashboards : `infra/grafana/provisioning/dashboards/dashboard.yml`
- Dashboards JSON :
  - `infra/grafana/dashboards/services-overview.json`
  - `infra/grafana/dashboards/taskflow-business.json`

Panels clés de `services-overview.json` alignés avec l’énoncé :

- `Request Rate per Service`
- `Latency p50/p95/p99`
- `Error Rate 5xx`
- `Service health (up)`

---

### 1.6 Documents liés au TP

- `TP_PARTIE_2.md` (énoncé ciblé stress test)
- `TP_PARTIE_1.md` (contexte observabilité)
- `README.md` (lancement stack, urls, requêtes)
- `REPORT.md` existant

Contrainte respectée dans cet audit : aucun changement de `REPORT.md`.

---

## 2) Incohérences énoncé ↔ repo (focus scripts k6)

## Incohérence A — Script cité vs commande

Dans `TP_PARTIE_2.md`, l’étape 1 dit de regarder `scripts/load-test-light.js` mais la commande donnée est :

```bash
k6 run -e TOKEN=<votre_token> scripts/load-test.js
```

Or `scripts/load-test.js` n’existe pas dans le repo. Le script disponible est `scripts/load-test-light.js`.

Impact : blocage immédiat pour l’étape 1 si on suit l’énoncé à la lettre.

## Incohérence B — Port Grafana vs port API

`TP_PARTIE_2.md` demande Grafana sur `http://localhost:3000`, alors que :

- d’après `docker-compose.infra.yml`, Grafana est sur `http://localhost:3004`
- d’après `docker-compose.yml`, l’API Gateway est sur `http://localhost:3000`

Les scripts k6 utilisent aussi `BASE_URL=http://localhost:3004` par défaut, ce qui vise Grafana et non l’API.

Impact : sans surcharge `-e BASE_URL=http://localhost:3000`, les requêtes k6 iront au mauvais service.

## Incohérence C — Chemin dashboard provisioning mentionné en Partie 1

Dans `TP_PARTIE_1.md`, une étape mentionne `infra/grafana/provisioning/dashboard/dashboard.yml` (singulier), alors que le repo utilise `.../dashboards/dashboard.yml` (pluriel).

Impact : faible pour la partie 2, mais source de confusion documentaire.

---

## 3) Blocages probables pour répondre aux questions 1 à 10

### Q1–Q2 (test léger)

- Blocage fort : commande vers `scripts/load-test.js` (absent).
- Blocage fort : `BASE_URL` par défaut vers `3004` (Grafana) au lieu de l’API.

### Q3–Q5 (test réaliste + interprétation charge)

- Exécutable si on corrige la commande/environnement à l’exécution (sans modifier le code) :
  - `k6 run -e BASE_URL=http://localhost:3000 ...`
- Risque d’interprétation : résultats invalides si base URL laissée par défaut.

### Q6 (erreur au scaling)

- Attendu : échec `--scale task-service=3` à cause du port host `3002:3002` déjà occupé.
- Ligne responsable clairement identifiable dans `docker-compose.yml`.

### Q7 (trafic sur replicas + targets Prometheus)

- Même après contournement du port publié, Prometheus reste en scrape statique unique (`task-service:3002`).
- Impossible d’avoir une visibilité individuelle triviale des 3 replicas dans la configuration actuelle.

### Q8 (limites docker scale)

- Le repo illustre bien les limites :
  - ports host statiques,
  - service discovery minimale,
  - scraping non dynamique,
  - pas d’autoscaling/health orchestration avancée.

### Q9 (Error Rate 5xx “No data”)

- Selon le type d’échec sous charge (timeouts, refus de connexion, erreurs client), k6 peut signaler des échecs sans HTTP 5xx applicatif.
- Le panel 5xx est donc potentiellement non pertinent pour détecter toutes les dégradations perçues client.

### Q10 (latence Grafana vs latence k6)

- Cohérent avec la note de l’énoncé : histogramme service-side ≠ latence end-to-end côté client.
- En surcharge, une partie des échecs peut se produire avant traitement applicatif (donc non mesurée par `http_request_duration_ms`).

---

## 4) Plan d’action minimal (concret et ordonné)

1. **Valider le périmètre d’exécution sans modifier le code**
   - Utiliser explicitement les scripts existants : `load-test-light.js` et `load-test-realistic.js`.
   - Toujours passer `-e BASE_URL=http://localhost:3000` lors des runs k6.

2. **Produire les mesures demandées pour Q1–Q5**
   - Lancer test léger puis réaliste.
   - Capturer terminal k6 + panel `Request Rate per Service`.

3. **Tester la manipulation scaling demandée (Q6)**
   - Exécuter `docker compose up --scale task-service=3` et capturer l’erreur exacte.
   - Pointer la ligne `ports: "3002:3002"` dans `docker-compose.yml`.

4. **Contourner minimalement pour continuer l’expérience (Q7)**
   - Faire uniquement la modif compose minimale autorisant le run multi-réplicas (sans refonte infra globale).
   - Rejouer k6 et vérifier Grafana + `/targets` Prometheus.

5. **Analyser les limites structurelles pour Q8–Q10**
   - Distinguer : erreurs HTTP serveur vs erreurs réseau/timeout côté client.
   - Expliquer l’écart de métriques service-side vs end-to-end.

6. **Reporter dans `REPORT.md` (phase suivante)**
   - À faire dans une étape séparée, avec preuves visuelles et résultats mesurés.

---

## 5) Synthèse exécutable immédiate

- On peut démarrer l’audit pratique TP2 dès maintenant **sans correction lourde** en utilisant correctement les variables d’environnement k6.
- Les incohérences documentaires principales sont identifiées et explicites.
- Le principal verrou technique pour la partie scaling est le couplage `ports` statiques + scrape Prometheus statique.
