# TaskFlow — TP5 Cloud & DevOps (Observabilité)

Monorepo pédagogique TaskFlow avec une stack d’observabilité complète (métriques, logs, traces) autour d’une architecture microservices.

## 1) Architecture

### Services applicatifs

| Service | Port hôte | Rôle |
|---|---:|---|
| `api-gateway` | 3000 | Point d’entrée unique, auth JWT, reverse proxy vers les services |
| `user-service` | 3001 | Gestion utilisateurs (inscription, login) |
| `task-service` | 3002 | CRUD des tâches, publication d’événements Redis |
| `notification-service` | 3003 | Abonné Redis Pub/Sub, création des notifications |
| `frontend` | 5173 | Interface web |

### Infrastructure de données

| Composant | Port hôte | Rôle |
|---|---:|---|
| PostgreSQL | 5432 | Stockage principal des utilisateurs et tâches |
| Redis | 6379 | Bus d’événements `task.created` / `task.status_changed` |

### Stack d’observabilité

| Composant | Port hôte | Rôle |
|---|---:|---|
| OTel Collector | 4317 / 4318 / 8888 | Réception OTLP, processing, export traces + métriques collector |
| Tempo | 3200 | Stockage/recherche de traces distribuées |
| Prometheus | 9090 | Scrape des métriques services + collector |
| Loki | 3100 | Stockage et interrogation des logs |
| Promtail | 9080 (interne) | Collecte logs Docker, parse JSON Pino, push vers Loki |
| Grafana | 3004 | Visualisation unifiée (dashboards + Explore) |

## 2) Prérequis

- Docker + Docker Compose
- Node.js 20+ et npm (pour installation locale / tests)
- Ports disponibles : `3000-3004`, `5173`, `5432`, `6379`, `9090`, `3200`, `3100`, `4317`, `4318`, `8888`

## 3) Installation et lancement

### 3.1 Installation dépendances

```bash
npm run install:all
```

### 3.2 Démarrage recommandé (ordre)

1. **Infra observabilité**
```bash
docker compose -f docker-compose.infra.yml up -d
```

2. **Stack applicative**
```bash
docker compose up --build
```

> Alternative : `npm run dev` (équivaut à `docker compose up --build`).

## 4) URLs utiles

- Frontend : http://localhost:5173
- API Gateway : http://localhost:3000
- Health checks :
  - http://localhost:3001/health
  - http://localhost:3002/health
  - http://localhost:3003/health
- Grafana : http://localhost:3004 (admin / admin)
- Prometheus UI : http://localhost:9090
- Tempo API/UI : http://localhost:3200
- Loki API : http://localhost:3100

## 5) Dashboards Grafana (provisioning auto)

Les datasources **Prometheus, Tempo et Loki** ainsi que les dashboards sont provisionnés automatiquement au démarrage de Grafana via :

- `infra/grafana/provisioning/datasources/datasources.yml`
- `infra/grafana/provisioning/dashboards/dashboard.yml`
- JSON versionnés dans `infra/grafana/dashboards/`

Aucune création manuelle n’est nécessaire pour retrouver les dashboards du TP.

## 6) Guide d’observation dans Grafana

### 6.1 Métriques (Prometheus)

Dans **Grafana > Explore > Prometheus** :

- Débit HTTP global :
```promql
sum by(job) (rate(http_requests_total{route!="/metrics"}[5m]))
```

- Erreurs 5xx (%) :
```promql
sum(rate(http_requests_total{status=~"5.."}[5m]))
/
sum(rate(http_requests_total[5m])) * 100
```

- Tâches créées/min :
```promql
sum(rate(tasks_created_total[5m])) * 60
```

- Transitions de statuts/min :
```promql
sum by(from_status, to_status) (rate(tasks_status_changes_total[5m])) * 60
```

- Répartition instantanée des tâches :
```promql
sum by(status) (tasks_gauge)
```

### 6.2 Logs (Loki)

Dans **Grafana > Explore > Loki** :

- Logs `task-service` :
```logql
{job="task-service"}
```

- Logs erreurs multi-services :
```logql
{compose_project="tp-taskflow-cloud", level="error"}
```

- Requêtes HTTP retournant 500 (via JSON Pino) :
```logql
{compose_project="tp-taskflow-cloud"} | json | statusCode=500
```

- Corrélation par trace :
```logql
{job="task-service"} | json | trace_id="<TRACE_ID>"
```

### 6.3 Traces (Tempo)

Dans **Grafana > Explore > Tempo** :

1. Lancer une action fonctionnelle (ex: création de tâche).
2. Rechercher les traces du service `api-gateway` ou `task-service`.
3. Ouvrir la trace distribuée et vérifier la chaîne :
   `api-gateway -> task-service -> postgres`.
4. Vérifier le span custom de publication Redis :
   - `publish.task.created`
   - (optionnel ajouté) `publish.task.status_changed`

## 7) Corrélation métriques -> logs -> traces (démarche)

1. **Métriques** : détecter une anomalie (hausse `5xx`, latence p95, etc.).
2. **Logs** : filtrer le service concerné et le niveau `error`, puis isoler la fenêtre temporelle.
3. **Traces** : récupérer le `trace_id` depuis le log JSON et ouvrir la trace Tempo pour identifier le span fautif.

## 8) Scénarios de tests manuels

### Scénario A — Création de tâche nominale

1. Créer un utilisateur puis se connecter depuis le frontend.
2. Créer une tâche via `POST /api/tasks`.
3. Vérifier :
   - incrément `tasks_created_total`
   - mise à jour `tasks_gauge`
   - log `task-service` avec `trace_id`/`span_id`
   - trace Tempo avec span `publish.task.created`
   - réception côté `notification-service` (`task.created`)

### Scénario B — Changement de statut

1. Mettre à jour une tâche via `PATCH /api/tasks/:id` avec `status` différent.
2. Vérifier :
   - incrément `tasks_status_changes_total{from_status,to_status}`
   - span `publish.task.status_changed`
   - notification associée dans `notification-service`

### Scénario C — Erreur applicative

1. Appeler `POST /api/tasks` sans `title`.
2. Vérifier `status=400` dans logs et métriques HTTP.
3. Déclencher un vrai 500 (ex: dépendance indisponible) pour observer filtre Loki `level="error"`.

## 9) Dépannage courant

- **Grafana vide au démarrage** : attendre 15-30s (scrape interval + boot services).
- **Aucune trace dans Tempo** : vérifier `OTEL_EXPORTER_OTLP_ENDPOINT` et que `otel-collector` écoute sur `4318`.
- **Aucun log Loki** : vérifier montage `/var/lib/docker/containers` et `docker.sock` dans Promtail.
- **Métriques absentes d’un service** : vérifier endpoint `/metrics` et job Prometheus correspondant.
- **Conflit de ports** : libérer les ports documentés ou adapter les mappings Compose.

## 10) Propreté du dépôt

- `.env` est ignoré par Git (seul `.env.example` est versionné).
- Les volumes de données sont gérés via volumes Docker nommés (`postgres_data`, `prometheus_data`, `tempo_data`, `loki_data`, `grafana_data`) et ne sont pas versionnés.
