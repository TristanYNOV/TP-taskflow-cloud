# TaskFlow — Cheatsheet redémarrage (Helm + Kubernetes)

Ce mémo sert à **redémarrer le projet**, **vérifier l’existant**, et se rappeler le rôle des outils/bibliothèques utilisés.

---

## 1) Prérequis (machine locale)

- `docker` (pour Kind et les images)
- `kubectl` (client Kubernetes)
- `kind` (cluster Kubernetes local dans Docker)
- `helm` (gestion des déploiements par chart)

---

## 2) Vérifier ce qui existe déjà

### Vérifier le cluster Kubernetes
```bash
kubectl config current-context
kubectl get nodes
```
- `current-context` : indique **sur quel cluster** `kubectl` pointe.
- `get nodes` : vérifie que le cluster répond et que les nœuds sont `Ready`.

Si erreur `localhost:8080 connection refused`, le cluster est absent/éteint ou le contexte est mauvais.

### Vérifier les clusters Kind
```bash
kind get clusters
```
- Liste les clusters Kind existants (ex: `taskflow`).

### Vérifier les namespaces
```bash
kubectl get ns
kubectl get ns staging
```
- `get ns` : liste tous les espaces de noms.
- `get ns staging` : confirme si le namespace de déploiement existe.

### Vérifier la release Helm
```bash
helm list -n staging
```
- Affiche les releases Helm présentes dans `staging`.
- Si `taskflow` n’apparaît pas, l’app n’est pas installée dans ce namespace.

---

## 3) Repartir de zéro (clean)

### (A) Recréer le cluster Kind
```bash
kind create cluster --name taskflow --config k8s/kind-config.yaml
kubectl config use-context kind-taskflow
kubectl get nodes
```
- Crée un cluster local nommé `taskflow` selon la config du repo.
- Bascule `kubectl` sur le bon contexte.

### (B) Recréer le namespace
```bash
kubectl delete ns staging --ignore-not-found=true
kubectl create ns staging
```
- Supprime puis recrée un namespace propre pour éviter les résidus.

### (C) Préparer les secrets Helm
```bash
cp helm/taskflow/values.secret.example.yaml helm/taskflow/values.secret.yaml
```
Puis éditer `helm/taskflow/values.secret.yaml` :
```yaml
secrets:
  postgresPassword: "..."
  jwtSecret: "..."
```
- Sépare les secrets des valeurs standard.
- Le fichier est ignoré par Git (`.gitignore`).

### (D) Mettre à jour les dépendances du chart
```bash
helm dependency update ./helm/taskflow
```
- Télécharge/met à jour les sous-charts (ex: Redis Bitnami).

### (E) Prévisualiser le rendu YAML
```bash
helm template taskflow ./helm/taskflow \
  --namespace staging \
  --values ./helm/taskflow/values.yaml \
  --values ./helm/taskflow/values.secret.yaml
```
- Génère les manifests sans les appliquer.
- Permet de détecter erreurs de template/variables avant déploiement.

### (F) Installer / Mettre à jour l’application
```bash
helm upgrade --install taskflow ./helm/taskflow \
  --namespace staging \
  --values ./helm/taskflow/values.yaml \
  --values ./helm/taskflow/values.secret.yaml
```
- `--install` : installe si absent.
- `upgrade` : met à jour si déjà présent.

---

## 4) Vérifications post-déploiement

```bash
helm list -n staging
kubectl get all -n staging
kubectl get pods -n staging -w
```
- Vérifie la présence de la release Helm.
- Vérifie les ressources Kubernetes créées.
- Suit le démarrage en direct (`-w`).

### Debug rapide
```bash
kubectl describe pod <pod> -n staging
kubectl logs deployment/<service> -n staging --tail=100
```
- `describe` : événements détaillés (image pull, probes, scheduling, secrets).
- `logs` : sorties applicatives récentes.

---

## 5) Mises à jour, diff et rollback

### Voir l’historique Helm
```bash
helm history taskflow -n staging
```
- Affiche les révisions déployées et statuts.

### Appliquer une modification
```bash
helm upgrade taskflow ./helm/taskflow \
  --namespace staging \
  --values ./helm/taskflow/values.yaml \
  --values ./helm/taskflow/values.secret.yaml
```

### Revenir à une révision précédente
```bash
helm rollback taskflow <revision> -n staging
```
- Restaure l’état de la release à la révision choisie.

---

## 6) Rôle des outils et bibliothèques utilisées

### Outils plateforme
- **Kubernetes** : orchestre les conteneurs (Pods, Deployments, Services, ConfigMaps, Secrets).
- **kubectl** : CLI pour interroger et administrer Kubernetes.
- **Kind** : lance un cluster Kubernetes local dans Docker (idéal pour TP/dev).
- **Helm** : “package manager” Kubernetes ; déploie une app via un chart paramétrable.

### Composants infra de l’application
- **PostgreSQL** : base relationnelle principale (utilisateurs, tâches).
- **Redis** : cache / bus PubSub (événements `task.created`, etc.).
- **Ingress NGINX** (si activé dans ton cluster) : entrée HTTP vers les services du namespace.

### Stack applicative Node.js
- **api-gateway** : point d’entrée API, auth et routage vers services internes.
- **user-service** : gestion compte utilisateur/login.
- **task-service** : CRUD des tâches + publication d’événements.
- **notification-service** : consomme les événements et produit les notifications.
- **frontend (Vite/React)** : interface web.

### Observabilité (selon le mode de lancement)
- **OpenTelemetry** : standard de traces/métriques instrumentées.
- **Prometheus** : collecte/stockage de métriques.
- **Loki + Promtail** : collecte et recherche de logs.
- **Tempo** : stockage et consultation des traces distribuées.
- **Grafana** : tableaux de bord et corrélation métriques/logs/traces.

---

## 7) Commandes “mémo minute”

```bash
# Contexte cluster
kubectl config current-context
kubectl get nodes

# Namespace + release
kubectl get ns staging
helm list -n staging

# Déploiement Helm
helm upgrade --install taskflow ./helm/taskflow -n staging \
  -f helm/taskflow/values.yaml -f helm/taskflow/values.secret.yaml

# État + debug
kubectl get pods -n staging -w
kubectl logs deployment/task-service -n staging --tail=100
kubectl describe pod <pod> -n staging

# Historique / rollback
helm history taskflow -n staging
helm rollback taskflow <revision> -n staging
```
