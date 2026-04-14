# REPORT — TaskFlow TP5 Observabilité

## 1. Fonctionnement global du projet

### 1.1 État de la stack

La stack d’observabilité est opérationnelle avec les composants suivants : OTel Collector, Tempo, Prometheus, Loki, Promtail, Grafana. Les données de métriques, logs et traces sont consultables depuis Grafana (datasources provisionnées automatiquement).

  A quoi sert chaque stack : 
- Prometheus --> Dessert la quantité d'information, offre une multitiude de données sur la vie de l'application
- Loki && promTail --> Agit comme journal en ligne de la vie de l'application. Il offre une visibilité sur les détails d'une erreur ou/et les actions réalisées dans le docker (lus par PromTail)
- Tempo --> Offre une vue qualitative sur les requêtes faites durant la vie de l'application, temps par étape, là où ca coince, ...
- Otel Collector --> Sert à connecter n'importe quel service métrique à une application grâce à 3 blocs; receiver (reçoit la donnée), processor (transforme la donnée) et exporter (export vers la bonne destination)
### 1.2 Reproductibilité

Le lancement repose sur deux commandes :

```bash
docker compose -f docker-compose.infra.yml up -d
docker compose up --build
```

ou 

```bash
npm run dev:infra
npm run dev
```

L’ordre est important pour éviter un démarrage applicatif avant disponibilité de l’infra d’observabilité.

### 1.3 Stabilité observée

- Les scrapes Prometheus sont stables (intervalle 15s).
- Les traces remontent de façon continue vers Tempo via OTel Collector (OTLP HTTP ingest, export gRPC).
- Les logs Docker JSON sont collectés par Promtail puis stockés dans Loki.

---

## 2. Implémentation technique

### 2.1 Traces distribuées

#### Chaîne observée

Sur un `POST /api/tasks`, la chaîne de spans attendue est :

- `api-gateway` (HTTP entrant/proxy)
- `task-service` (route Express)
- PostgreSQL (`INSERT ...`)
- publication Redis (span custom)

#### Span custom ajouté

Un span manuel a été ajouté autour de la publication Redis dans `task-service` :

- `publish.task.created`
- `publish.task.status_changed`

Points d’implémentation :

- span démarré juste avant `publish(...)`
- `setStatus(OK)` en succès
- `recordException` + `setStatus(ERROR)` en erreur
- fermeture **garantie** via bloc `finally` (même en cas d’exception)

### 2.2 Corrélation logs / traces

Le logger `task-service` enrichit désormais chaque log avec :

- `trace_id`
- `span_id`

Ces champs sont extraits côté Promtail (pipeline JSON) pour permettre une corrélation Grafana Explore entre Loki et Tempo.

### 2.3 Métriques métier

Métriques exploitées :

- `tasks_created_total{priority}`
- `tasks_status_changes_total{from_status,to_status}`
- `tasks_gauge{status}`
- `notifications_sent_total{event_type}`
- `http_requests_total{method,route,status}`
- `http_request_duration_ms` (histogram)

### 2.4 Dashboards

Dashboards versionnés/provisionnés :

- `services-overview.json`
- `taskflow-business.json`

Objectifs couverts :

- taux de requêtes, latence p50/p95/p99, taux d’erreurs
- KPIs métier (création tâches, transitions statuts, répartition)

---

## 3. Réponses théoriques structurées

### 3.1 Différence PromQL vs LogQL

- **PromQL** opère sur des séries temporelles numériques (counter, gauge, histogram).
- **LogQL** opère sur des flux de logs textuels/JSON avec filtres label + parsing pipeline.

Conclusion : PromQL est plus adapté à l’alerte et à la mesure globale ; LogQL est plus adapté au diagnostic détaillé d’un cas concret.

### 3.2 Pourquoi un span custom sur Redis/pubsub

L’auto-instrumentation couvre bien HTTP et PG, mais la publication d’événement métier Redis peut ne pas être suffisamment explicite dans la trace distribuée. Le span custom rend visible le coût et l’état de cette étape métier (succès/échec), ce qui améliore l’analyse de bout en bout.

### 3.3 Pourquoi corréler logs et traces

Sans `trace_id`, les logs restent isolés. Avec `trace_id`/`span_id`, on passe rapidement :

- d’un log d’erreur => trace complète => span fautif
- d’un pic métrique => logs ciblés => détail d’exécution

---

## 4. Requêtes utilisées et interprétation

### 4.1 PromQL

```promql
sum by(job) (rate(http_requests_total{route!="/metrics"}[5m]))
```
Interprétation : débit de requêtes par service (hors endpoint de scraping).

```promql
sum(rate(http_requests_total{status=~"5.."}[5m]))
/
sum(rate(http_requests_total[5m])) * 100
```
Interprétation : pourcentage d’erreurs serveur.

```promql
sum(rate(tasks_created_total[5m])) * 60
```
Interprétation : rythme de création de tâches par minute.

```promql
sum by(from_status, to_status) (rate(tasks_status_changes_total[5m])) * 60
```
Interprétation : transitions de workflow dominantes.

```promql
sum by(status) (tasks_gauge)
```
Interprétation : photographie instantanée du backlog par statut.

### 4.2 LogQL

```logql
{job="task-service"}
```
Interprétation : vue brute des logs du service.

```logql
{compose_project="tp-taskflow-cloud", level="error"}
```
Interprétation : erreurs transverses tous services.

```logql
{compose_project="tp-taskflow-cloud"} | json | statusCode=500
```
Interprétation : équivalent orienté logs d’un filtre HTTP 500.

```logql
{job="task-service"} | json | trace_id="<TRACE_ID>"
```
Interprétation : pivot direct vers une exécution distribuée unique.

### 4.3 TraceQL (Tempo)

```traceql
{ resource.service.name = "task-service" }
```
Interprétation : traces émises par task-service.

```traceql
{ name = "publish.task.created" }
```
Interprétation : validation de présence du span custom demandé.

```traceql
{ name = "publish.task.status_changed" }
```
Interprétation : contrôle du flux de changement d’état.

---

## 5. Observations concrètes

### 5.1 Scénario nominal (création de tâche)

- `tasks_created_total` augmente
- `tasks_gauge{status="todo"}` augmente
- logs `task-service` incluent `trace_id` / `span_id`
- trace distribuée contient `publish.task.created`
- `notification-service` reçoit `task.created`

### 5.2 Scénario transition de statut

- `tasks_status_changes_total{from_status,to_status}` augmente
- trace contient `publish.task.status_changed`
- notification de changement de statut émise

### 5.3 Scénario d’erreur

- erreur visible côté Loki via `level="error"`
- corrélation possible via `trace_id` pour remonter au span en erreur

---

## 6. Démarche d’investigation (métriques -> logs -> traces)

1. Détection dans dashboard (pic 5xx / latence p95).
2. Isolation du service impacté (PromQL par `job`).
3. Zoom temporel et recherche de logs `error` (Loki).
4. Extraction du `trace_id` du log.
5. Ouverture de la trace associée (Tempo).
6. Identification du span fautif et de son contexte (attributs HTTP/DB/custom).
7. Validation post-correctif par comparaison avant/après.

---

## 7. Justification des choix techniques

- **Span manuel ciblé** au lieu de refonte globale : répond précisément à l’exigence du TP et limite le risque de régression.
- **Ajout de `publish.task.status_changed`** : cohérence métier entre les deux événements sortants principaux.
- **Injection `trace_id/span_id` via logger** : amélioration légère et à forte valeur pour la corrélation.
- **Provisioning Grafana** : reproductibilité maximale et zéro configuration manuelle le jour de la soutenance.

---

## 8. Limites et améliorations possibles

- Ajouter la corrélation `trace_id/span_id` sur tous les services (pas uniquement `task-service`) pour uniformiser complètement l’investigation.
- Ajouter alerting Prometheus/Grafana (seuil 5xx, latence p95).
- Ajouter tests automatisés de présence de spans custom (tests d’intégration observabilité).

---

## 9. Captures d’écran à insérer (section explicite)
Tous les screens faits sont retrouvables dans le dossier /screens par section réalisée.
 Section actuelle: 
- /Part-1-StartMonitoring

---

## 10. Conclusion

Le socle observabilité est complet et exploitable : métriques, logs et traces convergent dans Grafana. Le TP est finalisé avec un span custom explicite sur la publication Redis de création de tâche, une corrélation logs/traces renforcée, une documentation opérationnelle (README) et un report structuré selon la grille d’évaluation.
