# Rapport TP Partie 3 - Kubernetes

## Partie 1 - Monter la stack avec K8S

### Etape 1 - Creer le cluster kind multi-noeuds

Commandes utilisees :

```bash
kind create cluster --name taskflow --config k8s/kind-config.yaml
kubectl get nodes
kubectl create namespace staging
```

Observations :
- 3 nodes sont créés
- Il y a 1 qui a pour rôle control-plane et 2 type 'worker' qui apparaisse en NONE
- Les noms sont incrémentés en cas de node identique
- Chacun des nodes est "READY"


![kind-createCluster-taskflow.png](screens/part3/kind-createCluster-taskflow.png)

![kind-getAll-worker.png](screens/part3/kind-getAll-worker.png)

![nameSpaceCreated.png](screens/part3/nameSpaceCreated.png)

### Etape 2 - Ouvrir les terminaux d'observation

Observations :
 Il n'y avait rien à ce moment 

### Etape 3 - Deployer le user-service

Observations :
Dans une première étape j'ai eu une erreur d'image car je n'avais publié aucune image sur le dockerHub. 
Après un fix sur le repo github, j'ai pu récupérer les images via la commande. 

![watchCreate&deployUserService.png](screens/part3/watchCreate%26deployUserService.png)

### Etape 4 - Deployer PostgreSQL

Observations :
Nous avons donc ajouter un nouveau service sur le worker 2: postgres mais avec une IP différente.

> Quelle propriété du StatefulSet garantit que chaque Pod conserve toujours le même volume de stockage, même après un redémarrage ou un rescheduling sur un autre nœud ?

La propriété importante est volumeClaimTemplates.
Dans un StatefulSet, chaque Pod reçoit une identité stable, par exemple postgres-0.
Même si le Pod redémarre ou est déplacé sur un autre nœud, il garde le même nom et récupère donc le même volume persistant.


>Pourquoi un Deployment serait-il inadapté pour PostgreSQL, même si techniquement on peut lui attacher un volume ?

  On risque d'augmenter les incohérences et perdre la main sur l'ordre d'éxécution de transaction sur la BDD dû à une conccurence d'accès à ces BDDs. 


>Parmi les services restants de la stack TaskFlow (Redis, notification-service, api-gateway, frontend), lequel mériterait potentiellement un StatefulSet plutôt qu'un Deployment en production ? Justifiez votre choix.

Redis peut être amener à circuler des informations importantes. En prod, il est donc intéressant de ne pas créer de la confusion dans ce service.


![kindCreatePostgres.png](screens/part3/kindCreatePostgres.png)

### Etape 5 - Deployer Notif Service et task service


>Comment ce service consomme-t-il les événements Redis ?

Le service de notification lit les événements publiés par Redis afin de les utiliser.

>Qu'est-ce que cela implique sur le nombre de replicas à choisir ? Pour quel(s) service(s) ?

Peu importe le nombre de service de notification que l'on déploit, tous écouterons la même instance de Redis. On risque donc d'être amené à plusieurs traitements identiques pour un même message. 
En conséquence il est plus intéressant de  n'avoir qu'un seul réplica du service de notification (car il dépend d'un état).

![add notif&taskService.png](screens/part3/add%20notif%26taskService.png)

### Etape 6 - Deployer Redis

Commandes utilisees :

```bash
kubectl apply -f k8s/base/redis/
kubectl get pods -n staging -o wide
```

Observations :

Redis est deploye avec un Deployment et un seul replica. Dans ce TP, Redis sert de bus de messages entre `task-service` et `notification-service`.
La perte des messages Redis au redemarrage est acceptable en environnement de staging, donc un volume persistant n'est pas necessaire ici.

Contrairement aux services HTTP, Redis ne fournit pas de route `/health`. La readiness probe utilise donc la commande `redis-cli ping`, qui permet de verifier que Redis accepte bien les connexions.

![redis.png](screens/part3/redis.png)

### Etape 7 - Deployer api-gateway et frontend

Commandes utilisees :

```bash
kubectl apply -f k8s/base/api-gateway/
kubectl apply -f k8s/base/frontend/
kubectl get pods -n staging -o wide
```

![front.png](screens/part3/front.png)

Choix des replicas :

- `api-gateway` : 2 replicas. C'est un service stateless qui route les requetes vers les services internes. Plusieurs replicas permettent de mieux repartir les requetes et de garder un minimum de disponibilite si un Pod tombe.
- `frontend` : 2 replicas. Le frontend sert des fichiers statiques via nginx. Il ne conserve pas d'etat partage entre les requetes, donc il peut etre replique facilement.

Choix des ressources :

- `api-gateway` execute du code Node.js a chaque requete et fait du proxy vers les services internes. Il a donc des ressources proches des autres services applicatifs.
- `frontend` sert principalement des fichiers precompiles. Il demande moins de CPU et de memoire que les services Node.js.

Impact d'une indisponibilite :

- Si `api-gateway` est indisponible, le frontend ne peut plus communiquer avec l'API.
- Si `frontend` est indisponible, l'utilisateur ne peut plus acceder a l'interface web, meme si les services backend fonctionnent encore.

### Etape 8 - Verifier que tout tourne

Commandes utilisees :

```bash
kubectl get all -n staging
kubectl logs -n staging deployment/task-service
kubectl logs -n staging deployment/user-service
kubectl logs -n staging deployment/notification-service
kubectl logs -n staging deployment/api-gateway
```

Observations :

- Tous les Pods doivent etre en `1/1 Running`.
- Les Services doivent etre presents pour `postgres`, `redis`, `user-service`, `task-service`, `notification-service`, `api-gateway` et `frontend`.
- Les Deployments doivent avoir le nombre de replicas attendu.
- Le StatefulSet PostgreSQL doit afficher un Pod stable, generalement `postgres-0`.

![logAll1.png](screens/part3/logAll1.png)
![logAll2.png](screens/part3/logAll2.png)

## Partie 2 - Exposer avec un Ingress

Commandes utilisees :

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=90s
kubectl get pods -n ingress-nginx -o wide
kubectl patch deployment ingress-nginx-controller -n ingress-nginx --type='json' -p='[{"op":"add","path":"/spec/template/spec/nodeSelector/ingress-ready","value":"true"}]'
kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx
kubectl apply -f k8s/base/ingress.yaml
curl http://localhost/api/health
```

### Test de creation de compte

> Essayez de créer un compte sur l'interface. Est-ce que ça fonctionne ?

Au premier test, la creation de compte peut echouer meme si l'Ingress, le frontend et l'api-gateway repondent correctement. Le probleme ne vient donc pas forcement du routage HTTP, mais d'un service plus loin dans la chaine.

La chaine de requete est :

```text
Navigateur -> Ingress NGINX -> api-gateway -> user-service -> PostgreSQL
```

En remontant les logs, on peut verifier chaque niveau :

```bash
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller
kubectl logs -n staging deployment/api-gateway
kubectl logs -n staging deployment/user-service
kubectl logs -n staging statefulset/postgres
```

Dans ce cas, l'erreur vient de PostgreSQL : la base existe, mais les tables applicatives ne sont pas creees. Le `user-service` tente d'ecrire dans la table `users`, mais cette table n'existe pas encore.

### Acces a PostgreSQL depuis la machine

> Comment accéder à PostgreSQL depuis votre machine ?

PostgreSQL est expose dans le cluster avec un Service interne. Pour y acceder depuis la machine, on peut ouvrir un tunnel temporaire avec `kubectl port-forward` :

```bash
kubectl port-forward -n staging svc/postgres 5432:5432
```

Dans un autre terminal, on peut ensuite se connecter avec :

```bash
psql postgresql://admin:admin@localhost:5432/taskflow
```

On peut aussi inspecter la base directement depuis le Pod :

```bash
kubectl exec -it -n staging statefulset/postgres -- psql -U admin -d taskflow
```

### Comparaison avec Docker Compose

> Comparez votre configuration Kubernetes avec docker-compose.yaml. Qu'est-ce qui est fait dans Compose et qui n'existe pas encore dans vos manifests ?

Dans `docker-compose.yml`, PostgreSQL monte le fichier `scripts/init.sql` dans le conteneur :

```yaml
./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql
```

Ce montage permet a PostgreSQL de creer automatiquement les tables `users`, `tasks` et `notifications` au premier demarrage.

Dans les manifests Kubernetes initiaux, cet equivalent n'existait pas encore. Le StatefulSet creait bien PostgreSQL, mais aucun script SQL n'etait applique pour initialiser le schema de la base.

### Correction apportee

> Rectifiez le problème et commentez votre investigation.

La correction consiste a ajouter l'initialisation SQL dans Kubernetes :

- `k8s/base/postgres/init-configmap.yaml` contient le contenu de `scripts/init.sql`.
- `k8s/base/postgres/init-job.yaml` lance un Job Kubernetes qui attend que PostgreSQL soit pret, puis execute le script SQL avec `psql`.
- `k8s/base/postgres/statefulset.yaml` monte aussi le script dans `/docker-entrypoint-initdb.d/init.sql` pour les futurs volumes vides.

![scriptInitDB.png](screens/part3/scriptInitDB.png)

Commandes de correction :

```bash
kubectl apply -f k8s/base/postgres/
kubectl logs -n staging job/postgres-init
```

Si le Job `postgres-init` existe deja et doit etre relance :

```bash
kubectl delete job postgres-init -n staging
kubectl apply -f k8s/base/postgres/init-job.yaml
```

Apres correction, la creation de compte doit fonctionner car la table `users` existe bien dans PostgreSQL.

![InitDBWorked.png](screens/part3/InitDBWorked.png)

### Service vs Ingress

> Vous avez utilisé une commande pour vous connecter à PostgreSQL depuis votre machine. Pourquoi n'avez-vous pas pu vous connecter directement sur `localhost:5432` sans celle-ci ?

Le Service PostgreSQL est un Service interne au cluster. Il est de type `ClusterIP`/headless et n'expose pas le port `5432` directement sur la machine hote. `localhost:5432` correspond a la machine locale, pas au reseau interne Kubernetes. La commande `kubectl port-forward` cree un tunnel temporaire entre la machine et le Service PostgreSQL.

> Quel composant du cluster fait réellement le routage HTTP que vous avez décrit dans votre `Ingress` ? Comment est-il apparu dans le cluster ?

Le routage HTTP est fait par le controller `ingress-nginx-controller`. La ressource `Ingress` ne route pas elle-meme le trafic : elle decrit les regles. Le controller NGINX lit ces regles et configure NGINX pour router les requetes vers les bons Services. Il est apparu dans le cluster apres l'application du manifest officiel `ingress-nginx` avec `kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml`.

> Dans votre cluster, qui joue le rôle de load balancer entre les replicas de `task-service` ? Est-ce l'Ingress, le Service, ou autre chose ?

Le load balancing entre les replicas de `task-service` est fait par le Service Kubernetes `task-service`, via les Endpoints/EndpointSlices maintenus par Kubernetes et les regles reseau du cluster. L'Ingress ne choisit pas directement un Pod `task-service` : il envoie les requetes vers `api-gateway`. Ensuite, `api-gateway` appelle le Service `task-service`, et ce Service repartit les requetes entre les Pods disponibles.

Cela montre que l'Ingress sert surtout de point d'entree HTTP depuis l'exterieur du cluster. Le load balancing interne entre replicas est plutot le role des Services Kubernetes.

## Partie 3 - Scenarios d'observation

Les manipulations suivantes n'ont pas toutes ete rejouees. Les reponses ci-dessous expliquent le comportement attendu de Kubernetes a partir de la configuration des manifests.

### Scenario 1 - Self-healing

Commande du scenario :

```bash
kubectl delete pod -n staging -l app=task-service
```

> Décrivez ce que vous voyez et pourquoi Kubernetes recrée les Pods.

Quand on supprime les Pods du `task-service`, ils disparaissent temporairement de la liste. Ensuite, Kubernetes en cree automatiquement de nouveaux pour revenir a l'etat desire dans le Deployment.

Ce comportement vient du Deployment `task-service`, qui declare un nombre de replicas attendu. Le Deployment ne gere pas directement les Pods : il s'appuie sur un ReplicaSet. Le ReplicaSet compare en permanence l'etat reel du cluster avec l'etat desire. Si des Pods manquent, il en recree.

Kubernetes ne "sauve" donc pas le Pod supprime. Il le remplace par un nouveau Pod, avec un nouveau nom et potentiellement une nouvelle IP. Comme le trafic passe par le Service `task-service`, les clients n'ont pas besoin de connaitre le nom ou l'IP des Pods.

![logOnRebuild.png](screens/part3/logOnRebuild.png)

![logAfterStoppedAdnRebuilt.png](screens/part3/logAfterStoppedAdnRebuilt.png)

### Scenario 2 - Readiness probe

> Dans quel état sont les pods du `task-service` si la readiness probe pointe vers `/does-not-exist` ?

Les Pods du `task-service` peuvent etre en etat `Running`, mais leur colonne `READY` reste a `0/1`. Le conteneur tourne, mais Kubernetes considere que l'application n'est pas prete a recevoir du trafic.

> Essayez de vous connecter, puis de créer une tâche. Quels services répondent, lesquels ne répondent pas ?

Le frontend peut encore repondre, car il sert des fichiers statiques. L'api-gateway peut aussi repondre a son endpoint `/health`.

En revanche, la creation de tache echoue, car elle passe par :

```text
frontend -> api-gateway -> task-service -> PostgreSQL / Redis
```

Si `task-service` n'est pas Ready, le Service Kubernetes `task-service` ne doit pas envoyer de trafic vers ses Pods. L'api-gateway risque donc de recevoir une erreur lorsqu'il tente d'appeler `task-service`.

> Que se passe-t-il apres avoir remis le path a `/health` ?

Quand la readiness probe pointe de nouveau vers `/health`, Kubernetes considere les Pods comme prets. La colonne `READY` repasse a `1/1`, les Pods redeviennent des endpoints valides du Service `task-service`, et la creation de tache peut refonctionner.

> Expliquez la différence entre une readiness probe et une liveness probe.

La readiness probe indique si un Pod est pret a recevoir du trafic. Si elle echoue, Kubernetes garde le conteneur en vie, mais retire le Pod des endpoints du Service. C'est utile quand l'application demarre lentement, attend une dependance, ou ne doit pas encore recevoir de requetes.

La liveness probe indique si le conteneur est encore vivant. Si elle echoue plusieurs fois, Kubernetes redemarre le conteneur. C'est utile pour recuperer une application bloquee ou dans un etat irrecuperable.

> Que se serait-il passé si vous aviez cassé la liveness probe à la place ?

Si la liveness probe avait ete cassee, Kubernetes aurait considere le conteneur comme non sain et l'aurait redemarre en boucle. Le Pod aurait pu tomber en `CrashLoopBackOff` ou afficher de nombreux redemarrages. Le probleme aurait ete plus violent qu'une readiness probe cassee, car Kubernetes ne se contenterait pas de retirer le Pod du trafic : il tuerait et relancerait le conteneur.

### Scenario 3 - Rolling update

> Pendant le rolling update, le nombre de pods disponibles a-t-il diminué ? Pourquoi ?

Pendant un rolling update, Kubernetes remplace progressivement les anciens Pods par les nouveaux. Avec un Deployment, il evite normalement de supprimer tous les anciens Pods d'un coup. Il cree de nouveaux Pods, attend qu'ils soient Ready, puis retire les anciens.

Le nombre de Pods disponibles ne doit donc pas chuter brutalement si les probes sont correctes et si les ressources du cluster permettent de scheduler les nouveaux Pods. C'est ce qui permet de deployer une nouvelle version avec peu ou pas d'interruption.

> Que se serait-il passé si le nouveau pod n'était jamais passé en `1/1` ?

Si le nouveau Pod ne passe jamais en `1/1`, Kubernetes ne le considere pas comme disponible. Le rollout reste bloque, et les anciens Pods peuvent continuer a servir le trafic tant que la strategie de rollout ne les a pas tous retires.

Cela protege l'application : une version defectueuse ne remplace pas completement une version encore fonctionnelle. On peut alors inspecter l'etat avec :

```bash
kubectl rollout status -n staging deployment/frontend
kubectl describe pod -n staging -l app=frontend
kubectl logs -n staging deployment/frontend
```

> Pourquoi annoter les révisions est-il important en équipe ?

Annoter les revisions avec `kubernetes.io/change-cause` rend l'historique plus lisible. Sans annotation, `kubectl rollout history` affiche des revisions techniques, mais on ne sait pas toujours quelle modification correspond a quelle revision.

En equipe, cela aide a comprendre rapidement qui a deploye quoi, pourquoi une revision existe, et vers quelle version revenir en cas de probleme. Cela evite de faire un rollback a l'aveugle.

> `kubectl rollout undo` est-il suffisant comme stratégie de rollback en production ? Quelles limites voyez-vous ?

`kubectl rollout undo` est utile, mais ce n'est pas suffisant comme strategie complete de rollback en production.

Ses limites :

- Il revient sur le manifeste du Deployment, mais pas forcement sur tout le contexte applicatif.
- Il ne rollback pas automatiquement les migrations de base de donnees.
- Il ne restaure pas les donnees modifiees par une version defectueuse.
- Il peut etre insuffisant si des ConfigMaps, Secrets, images externes ou dependances ont aussi change.
- Il ne remplace pas une strategie de deploiement testee, observable et documentee.

En production, il faut plutot combiner rollback, versionnement des images, migrations compatibles, monitoring, alerting, tests de sante, et eventuellement des strategies comme blue/green ou canary.

### Reflexion theorique

> Identifiez au moins 3 valeurs que vous avez répétées dans plusieurs fichiers. Que se passe-t-il concrètement si vous devez changer l'une d'elles pour un déploiement en production ?

Plusieurs valeurs sont repetees dans les manifests :

- Le namespace `staging`.
- Les noms de Services : `postgres`, `redis`, `user-service`, `task-service`, `notification-service`, `api-gateway`, `frontend`.
- Les URLs internes comme `http://user-service:3001`, `http://task-service:3002`, `redis://redis:6379` ou `postgresql://admin:admin@postgres:5432/taskflow`.
- Les tags d'images Docker, par exemple `tristangottschalk/taskflow-frontend:latest`.
- Les ports applicatifs : `3000`, `3001`, `3002`, `3003`, `6379`, `5432`.
- Les valeurs de ressources `requests` et `limits`.

Si on doit passer de `staging` a `production`, il faut modifier ces valeurs dans beaucoup de fichiers. Cela augmente le risque d'oubli ou d'incoherence. Par exemple, si on renomme un Service dans un fichier mais pas dans les ConfigMaps qui contiennent les URLs, les Pods demarrent mais ne peuvent plus communiquer entre eux.

C'est ce genre de repetition qui motive l'utilisation d'outils comme Helm ou Kustomize. Ils permettent de centraliser les valeurs variables selon l'environnement et de generer des manifests coherents pour `staging`, `production`, ou d'autres environnements.
