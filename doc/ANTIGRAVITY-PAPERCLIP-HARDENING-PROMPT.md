# Mandat Antigravity — Durcissement Paperclip post-audit

Copier l’intégralité de ce document dans Antigravity.

---

Tu interviens sur `haykel1977/paperclip` après un audit complet de sécurité, gouvernance, CI/CD et exploitation.

## Règles impératives

- Utiliser uniquement des modèles souverains dont la provenance est attestée. Ne pas considérer le mot `sovereign` dans un identifiant ou un label comme une preuve.
- Ne jamais pousser directement sur `main`.
- Créer une branche et une PR focalisée par lot cohérent.
- Ne jamais affaiblir temporairement la protection de branche pour fusionner une PR.
- Exiger au minimum une approbation humaine et les quatre checks protégés avant chaque fusion.
- Ne jamais afficher, enregistrer ou committer un secret npm, GitHub, JWT ou cloud.
- Ne pas déclarer un contrôle vert avant confirmation par les check-runs GitHub.
- Pour chaque lot : fournir tests, preuve CI, risque, rollback et impact de déploiement.
- Si une décision juridique, de confiance ou de produit manque, produire un ADR court avec options et demander une décision humaine au lieu d’inventer une politique.

## État de départ à vérifier

- `main` doit contenir au minimum `6622b02a630fd1de81d22ae451d0f40a5d4debf7` (PR #52, gouvernance fail-closed).
- La PR #40 Better Auth a été rebasée au SHA `eeb63bb5439903caa2cb3b42bd2919db4b5d0db4`. Vérifier son état actuel ; ne la fusionner que si elle est à jour, approuvée et si tous les checks requis sont verts.
- Le runtime `quantum-dev.kantum.dev` utilisait encore l’image `main-b32ac930` au moment du rapport.
- Une branche Dyad séparée ajoute normalement :
  - `registry-url: https://registry.npmjs.org` aux jobs `publish_canary` et `publish_stable` ;
  - validation des JWT agents contre le run actif, l’agent, la compagnie et l’adapter ;
  - refus d’un `X-Paperclip-Run-Id` contradictoire ;
  - `jti` unique et validation stricte issuer/audience ;
  - confiance dans `X-Forwarded-Host/Proto` désactivée par défaut, activable par `PAPERCLIP_TRUST_PROXY_HEADERS=true`.
- Rechercher ces changements avant de les réimplémenter.

## Lot 1 — Rétablir les publications npm (P0)

### Objectif

Rendre canary et stable publiables de façon reproductible et sans secret longue durée si OIDC est disponible.

### Actions

1. Lire `scripts/release-package-map.mjs` et inventorier tous les packages publiés, leur scope, leur accès npm et leur version canary actuelle.
2. Sur npmjs.com, vérifier pour chaque package si une version du canary interrompu a été partiellement publiée. Produire un tableau package/version/dist-tag ; ne supprimer ni déprécier une version sans validation humaine.
3. Préférer npm Trusted Publishing OIDC :
   - lier chaque package au dépôt `haykel1977/paperclip` ;
   - lier le workflow exact `.github/workflows/release.yml` ;
   - conserver `id-token: write` uniquement sur les jobs de publication ;
   - vérifier que la version npm CLI du runner prend en charge Trusted Publishing.
4. Si OIDC ne peut pas être activé, utiliser un granular access token limité aux packages nécessaires, stocké dans les environnements GitHub `npm-canary` et `npm-stable` sous `NPM_TOKEN`. Ne jamais utiliser un token classique global.
5. Vérifier que `actions/setup-node` des deux jobs de publication configure `registry-url: https://registry.npmjs.org`.
6. Ajouter un diagnostic fail-closed avant toute publication qui confirme la méthode d’authentification configurée sans afficher le secret. Ne pas utiliser `npm whoami` comme unique preuve si le flux est OIDC, car l’échange peut n’avoir lieu qu’au publish.
7. Évaluer le risque de publication partielle du script séquentiel. Ajouter au minimum un plan pré-calculé de toutes les versions, une vérification qu’aucune version cible n’existe déjà et un rapport final des packages publiés.
8. Déclencher une canary contrôlée, confirmer le dist-tag et conserver les logs de preuve.

### Acceptation

- Aucun `ENEEDAUTH`.
- Tous les packages du registre de release portent la même version canary attendue.
- Le tag Git canary correspond exactement aux artefacts npm.
- Aucun secret n’apparaît dans les logs.

## Lot 2 — Finaliser Better Auth et déployer (P1)

1. Vérifier la PR #40 et ses checks sur son SHA courant.
2. Obtenir l’approbation humaine requise, fusionner sans contourner les protections.
3. Attendre le build Docker du SHA fusionné et utiliser un tag immuable, jamais seulement `latest`.
4. Déployer sur `quantum-dev.kantum.dev` en conservant l’ancienne image comme rollback.
5. Vérifier : health, bootstrap ready, login, session, logout, mutation avec Origin valide, rejet Origin invalide, et absence d’erreurs serveur.
6. En cas d’échec, restaurer immédiatement `main-b32ac930` et documenter la cause.

## Lot 3 — Souveraineté vérifiable des modèles (P0, décision humaine requise)

### Constat

`packages/shared/src/sovereign-models.ts` accepte actuellement des chaînes contenant `sovereign`/`souverain`. Certains adapters préfixent automatiquement des modèles Anthropic/OpenAI hébergés avec `Sovereign`. Ce n’est pas une attestation.

### Livrable de décision

Créer un ADR proposant une politique structurée, default-deny, avec au minimum :

```ts
interface SovereignModelAttestation {
  adapterType: string;
  modelId: string;
  providerId: string;
  endpointOrigins: string[];
  deploymentClass: "local" | "dedicated" | "approved-cloud-region";
  regions: string[];
  evidenceRef: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt?: string;
}
```

Décisions humaines nécessaires : fournisseurs autorisés, régions, critères juridiques, Bedrock éventuel, endpoints dédiés et durée de l’attestation.

### Implémentation après décision

- Supprimer toute auto-labellisation `Sovereign` des modèles découverts.
- Centraliser l’allowlist attestée dans un seul module/configuration signée.
- Vérifier modèle + adapter + provider + origine d’endpoint avant création, import, duplication, sélection de profil et exécution.
- Refuser par défaut toute provenance inconnue.
- Ajouter des tests adversariaux : faux label, endpoint modifié, provider non attesté, attestation expirée, import forgé.
- Prévoir une migration qui bloque proprement les agents historiques non attestés sans les exécuter.

## Lot 4 — Isolation des plugins (P0/P1, décision humaine requise)

### Décision immédiate

Choisir explicitement l’un des contrats :

1. **Plugins privilégiés** : code administrateur totalement fiable, équivalent à du code serveur ; ou
2. **Plugins non fiables** : isolation OS obligatoire.

En attendant une vraie sandbox, adopter fail-closed : documenter les plugins comme privilégiés, réserver installation/activation aux instance admins, afficher un avertissement clair et exiger une confirmation explicite.

### Cible recommandée

- Un conteneur ou sandbox OS par plugin.
- Utilisateur non privilégié, filesystem read-only, répertoire de données dédié.
- Aucun socket Docker, aucune variable secrète implicite.
- Egress réseau refusé par défaut, allowlist par capacité.
- Limites CPU, mémoire, processus et temps.
- Seccomp/AppArmor ou équivalent.
- RPC authentifié et scoping compagnie conservé.
- Arrêt/révocation immédiate à la désactivation.

Le fichier `plugin-runtime-sandbox.ts` non utilisé ne doit pas être présenté comme une frontière de sécurité : une VM Node seule n’est pas une isolation OS suffisante.

## Lot 5 — JWT agents restant (P1)

Vérifier d’abord la présence du binding au run actif ajouté par Dyad.

Puis :

- supprimer le partage de secret entre Better Auth et JWT agents après migration contrôlée ;
- rendre `PAPERCLIP_AGENT_JWT_SECRET` obligatoire en mode authenticated ;
- définir une stratégie de durée compatible avec les runs longs : jeton court renouvelable ou credential opaque par run révoqué en DB ;
- conserver un `jti` unique et une révocation immédiate à la fin/annulation du run ;
- rejeter issuer/audience absents, `iat` futur, adapter/company/run incohérents ;
- ajouter des tests de replay après fin de run, run annulé, header de run forgé et changement d’adapter.

Ne pas réduire arbitrairement le TTL à quelques minutes sans mécanisme de renouvellement pour les processus agents longs.

## Lot 6 — Rôles Cloud tenant (P1, décision humaine requise)

Créer un ADR sur le mapping attendu :

- `owner`/`admin` → instance admin ou administration limitée à la stack ;
- `member` → membre compagnie, jamais instance admin par défaut ;
- `support` → rôle de support explicitement borné, audité et temporaire.

Puis corriger `resolveCloudTenantActor()` : ne plus insérer systématiquement `instance_admin`. Ajouter des tests pour chaque rôle, changement de rôle, révocation et accès inter-stack.

## Lot 7 — Gouvernance et chaîne d’approvisionnement (P1/P2)

- Diagnostiquer le check `review` qui échoue encore ; ne pas le rendre obligatoire avant qu’il soit stable et fail-closed.
- Décider si une advisory sécurité RED doit produire un check bloquant. Documenter le propriétaire de la décision.
- Épingler chaque action GitHub tierce par SHA complet, comme le workflow commitperclip sensible le fait déjà.
- Remplacer les installations Release non figées par une stratégie reproductible. Tenir compte du workflow séparé de refresh du lockfile : ne pas simplement activer `--frozen-lockfile` si `main` peut momentanément contenir un manifeste sans lockfile correspondant. Corriger le contrat global.
- Conserver les permissions GitHub minimales par job.

## Lot 8 — Docker, tests et maintenabilité (P2, PR séparées)

- Construire une image runtime minimale avec artefacts compilés et dépendances de production seulement.
- Retirer tests, sources inutiles et outils non requis du runtime ; conserver uniquement les outils nécessaires aux adapters explicitement supportés.
- Épingler l’image de base par digest et générer SBOM + provenance.
- Ajouter un typecheck dédié des tests serveur.
- Ajouter des seuils de couverture progressifs sans masquer les tests d’intégration PostgreSQL.
- Découper progressivement, sans big-bang, les modules géants : `heartbeat.ts`, `issues.ts`, `company-portability.ts`, `access.ts`, `agents.ts`, `plugin-host-services.ts`.

## Sortie finale obligatoire

Produire :

1. tableau des lots, PR, SHA et statut CI ;
2. décisions humaines encore ouvertes ;
3. versions npm vérifiées et éventuelles publications partielles ;
4. image déployée et résultat des smoke tests ;
5. risques résiduels ;
6. rollback précis pour chaque modification ;
7. affirmation explicite qu’aucune protection de branche n’a été affaiblie et qu’aucun secret n’a été exposé.
