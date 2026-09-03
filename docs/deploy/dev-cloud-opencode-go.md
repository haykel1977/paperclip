---
title: Déploiement cloud de développement
summary: État constaté, ce qui est fait, ce qui ne l'est pas, retour au souverain, vérifications, rollback
---

> Language: French — operator-facing runbook. English summary: this page describes the development Paperclip deployment that runs four agents on OpenCode Go cloud models in deviation from the sovereign doctrine (see ADR-IA-018). It records what was observed on 2026-09-03, what is done, what is not, the return-to-sovereign procedure, verification commands and rollback. It authorizes nothing.

Ce runbook décrit le déploiement Paperclip de développement qui fait tourner des agents sur des modèles cloud OpenCode Go, en déviation de la doctrine souveraine. La déviation est décrite dans [ADR-IA-018](/adr/ADR-IA-018-mode-cloud-rnd). Ce runbook ne l'autorise pas. Il dit ce qui est, ce qui manque, et comment revenir en arrière.

Règles de rédaction : dépôt public. Aucune adresse interne, aucun nom d'hôte interne, aucun identifiant de base, aucun nom de clé, aucune valeur de secret, aucune version ni topologie d'infrastructure au-delà du nécessaire. Les commandes utilisent des espaces réservés entre chevrons. Les jetons se lisent depuis un fichier en mode 0600, jamais tapés en clair. Les valeurs exactes omises ici sont dans le miroir privé de l'ADR (dépôt quantum).

Étiquettes : VERIFIED = constaté le 2026-09-03 ; UNVERIFIABLE = non constaté ; PROPOSED = à faire, non décidé.

## État constaté le 2026-09-03

| Élément | État | Étiquette |
|---|---|---|
| Paperclip | image `paperclip:main-ca53c5f` (fork, PR #100 « opt-in cloud model support »), conteneur redémarré le 2026-09-03 à 13:57 UTC | VERIFIED |
| CLI opencode dans le conteneur | 1.17.7, installé par `npm install -g` dans l'image ; `opencode models` liste `opencode-go/*` (28 modèles), `opencode/*` (Zen) et `bifrost/*` (provider custom) | VERIFIED |
| Agents | 20 lignes : 4 `idle` (Q-Gov, Q-Impl, Q-Web, QA-Tests), 16 `terminated` le 2026-09-02 | VERIFIED |
| Modèles des 4 agents | `opencode-go/deepseek-v4-pro` (Q-Gov), `opencode-go/kimi-k2.7-code` (Q-Impl, Q-Web), `opencode-go/glm-5.3-flash` (QA-Tests) ; small model `opencode-go/glm-5.3-flash` | VERIFIED |
| Répertoire de travail des agents | checkout local du dépôt quantum (racine ; `apps/web` pour Q-Web) | VERIFIED |
| `adapter_config.env` des 4 agents (noms) | `HOME`, `AGENT_PR_WRAPPER_REQUIRED`, `OPENCODE_ALLOW_ALL_MODELS`, `PAPERCLIP_OPENCODE_SMALL_MODEL` — injectés dans l'environnement de chaque run, indépendamment de l'environnement du conteneur | VERIFIED (FACTS ; R3) |
| Budgets | `budget_monthly_cents = 0` pour les 4 : aucune limite | VERIFIED |
| Dépense déclarée depuis le 02/09 (cents, coût déclaré par le CLI) | Q-Gov 589, Q-Impl 946, Q-Web 236, QA-Tests 25 | VERIFIED en base ; exactitude économique UNVERIFIABLE |
| Runs depuis le 02/09 (total / ok) | Q-Gov 32/29, Q-Impl 62/61, Q-Web 68/45, QA-Tests 36/26 | VERIFIED |
| Variables non secrètes du conteneur | `PAPERCLIP_ALLOW_CLOUD_MODELS=1`, `OPENCODE_ALLOW_ALL_MODELS=true`, `PAPERCLIP_LLM_MODE=sovereign`, `PAPERCLIP_DELIVERY_LANE=dev`, `PAPERCLIP_AUTONOMOUS_DELIVERY=1`, `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`, `OPENAI_BASE_URL` = passerelle Bifrost locale, `OPENAI_MODEL_NAME=qwen3-coder-30b-sovereign` | VERIFIED |
| Providers déclarés dans l'environnement | `bifrost` (local) et `openrouter` (clé retirée le 03/09, 0 appel : bloc mort) | VERIFIED |
| Chemin d'egress | conteneur → `opencode.ai` directement ; Bifrost ne voit aucun appel des agents depuis 10:30 UTC | VERIFIED par inférence (provider intégré au binaire, aucun proxy configuré, 0 requête Bifrost, DNS `opencode.ai` → Cloudflare) ; capture du flux sortant non réalisée (UNVERIFIABLE) |
| Bifrost | providers `ollama`, `vllm`, `vllm-embed` ; zéro provider cloud ; clé virtuelle exigée (anonyme → 401) ; content logging désactivé ; rétention 30 jours (version : miroir privé) | VERIFIED |
| GPU souverain | vLLM en ligne, 0 % d'utilisation, environ 63 % de VRAM occupée | VERIFIED (nvidia-smi 14:05 UTC ; valeurs brutes dans le miroir privé) |
| Secrets | clés d'accès du déploiement (clé board, clé virtuelle de passerelle) renouvelées le 2026-09-03 | VERIFIED (noms non reproduits ; motif dans le miroir privé) |

## Ce qui est déjà fait

- Flag cloud : `PAPERCLIP_ALLOW_CLOUD_MODELS=1` dans l'environnement du conteneur. Il est lu à chaque requête. Seule la valeur littérale `1` l'active.
- Secrets : présents dans l'environnement du conteneur (noms connus, valeurs non reproduites) — VERIFIED. Mode d'injection (fichier d'environnement 0600, `-e`, orchestrateur) et exposition via `docker inspect` ou l'unité de lancement : UNVERIFIABLE, à constater lors de la prochaine recréation du conteneur.
- Modèles des 4 agents posés sur les trois ids ci-dessus. Ils n'ont pas pu l'être via le formulaire de l'interface (qui filtre côté client sans lire le flag) ; le canal exact (API, import, SQL) est UNVERIFIABLE.
- Clés d'accès renouvelées, clé OpenRouter retirée de l'environnement.
- Bifrost : authentification par clé virtuelle active, content logging désactivé.
- Le GPU souverain et son endpoint vLLM restent en ligne. Le retour au souverain ne dépend d'aucune remise en service.

## Ce qui n'est PAS fait

| Point du plan | Réalité | Étiquette |
|---|---|---|
| Bifrost porte des providers `go_agents`, `nvidia`, `modelscope`, `zai`, `groq` et des modèles virtuels `role-*` | Rien de cela n'existe. Bifrost n'a que des providers locaux. | VERIFIED |
| Chaînes de repli (fallback) | Aucune. Un seul fournisseur : OpenCode Go, en appel direct. | VERIFIED |
| Budgets par agent avec alerte 80 % et arrêt 100 % | Budgets à 0. Aucune politique `budget_policies`. | VERIFIED |
| Renommages (Q-Gov → Q-Infra, agent-5 → Reviewer, Documentation → Librarian) | Non faits. agent-5 n'existe pas. Documentation est `terminated`. | VERIFIED |
| Suspension des agents souverains (état conservé) | Terminaison, pas suspension. 16 agents `terminated` ; la route de terminaison révoque les clés (code) ; révocation effective en base non constatée. | VERIFIED (statut) ; révocation UNVERIFIABLE |
| Étiquette `PAPERCLIP_LLM_MODE` alignée sur la réalité | Vaut encore `sovereign`. Variable inerte dans le code Paperclip, mais fausse pour un lecteur humain. | VERIFIED |
| Bloc provider `openrouter` retiré | Toujours déclaré, clé absente. | VERIFIED |
| Catalogue fermé aux trois modèles utiles | `OPENCODE_ALLOW_ALL_MODELS=true` : 28 modèles sélectionnables dont `grok-4.6` et `gpt-5.6-luna`. | VERIFIED |
| Agent reviewer sur un modèle différent des coders | Aucun agent reviewer. Aucune revue humaine systématique non plus : posture dev full-auto du dépôt quantum (ADR-GOV-015 §3.1). | VERIFIED |
| Embeddings `bge-m3` hors GPU souverain | Non traité ici. | UNVERIFIABLE |
| Header `x-served-by` et label `same-model-review` | Non fait : VERIFIED. Faisabilité sans Bifrost en coupure : déduction (PROPOSED). | voir ligne |
| Runner CI auto-hébergé retiré des workflows | 20 workflows du dépôt quantum le référencent encore. Hors périmètre de ce runbook. | VERIFIED (inventaire) |
| Filtrage réseau sortant du conteneur | Aucun filtrage constaté. | UNVERIFIABLE (absence non prouvée) |
| ADR signée par l'opérateur | En attente. Sans signature, la déviation n'est pas couverte. | VERIFIED |

## Procédure de retour au souverain

Préalables : vLLM en ligne sur le GPU souverain (VERIFIED le 2026-09-03) ; provider `vllm` configuré dans Bifrost (VERIFIED) ; `opencode models` dans le conteneur liste le provider `bifrost/*` (VERIFIED) — la présence de l'id exact `bifrost/qwen3-coder-30b-sovereign` est à confirmer par la commande de la section Vérifications avant l'étape 2 (la sonde pré-run échoue sinon, bruyamment). Si l'un manque, corriger avant.

Ordre déduit du code du fork (R3). Toutes les routes sont réservées au board.

1. Mettre chaque agent en pause. La pause annule les runs actifs.

```bash
PAPERCLIP_URL=https://paperclip.kantum.dev
TOKEN_FILE=<chemin-fichier-0600>
for AGENT_ID in <id-q-gov> <id-q-impl> <id-q-web> <id-qa-tests>; do
  curl -sS -X POST "$PAPERCLIP_URL/api/agents/$AGENT_ID/pause" \
    -H "Authorization: Bearer $(cat "$TOKEN_FILE")"
done
```

2. Remplacer le modèle. Le `PATCH` fait un merge au premier niveau de `adapterConfig` : `env` et `cwd` ne sont pas touchés par cette requête. Une révision de configuration est enregistrée (rollback possible).

```bash
for AGENT_ID in <id-q-gov> <id-q-impl> <id-q-web> <id-qa-tests>; do
  curl -sS -X PATCH "$PAPERCLIP_URL/api/agents/$AGENT_ID" \
    -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
    -H 'Content-Type: application/json' \
    -d '{"adapterConfig":{"model":"bifrost/qwen3-coder-30b-sovereign"}}'
done
```

Alternative acceptée par le code : `openai/qwen3-coder-30b-sovereign`. Ce format saute la sonde `opencode models` et passe par `OPENAI_BASE_URL` (Bifrost). Les deux ids contiennent le mot `sovereign`, donc passent le garde flag éteint.

2 bis. Réécrire l'environnement par agent. `adapter_config.env` contient `PAPERCLIP_OPENCODE_SMALL_MODEL` et `OPENCODE_ALLOW_ALL_MODELS` ; ces valeurs sont injectées dans l'environnement de chaque run et survivent au retrait des variables du conteneur. Le garde souverain de Paperclip ne contrôle que `adapterConfig.model`, jamais le small model du CLI : sans cette étape, un egress cloud résiduel subsiste si le composant hors dépôt qui consomme `PAPERCLIP_OPENCODE_SMALL_MODEL` l'honore (UNVERIFIABLE). Le merge est au premier niveau : fournir `env` remplace tout l'objet. Relire d'abord `GET /api/agents/<id>` et recopier les clés à conserver (`HOME`, `AGENT_PR_WRAPPER_REQUIRED`).

```bash
for AGENT_ID in <id-q-gov> <id-q-impl> <id-q-web> <id-qa-tests>; do
  curl -sS "$PAPERCLIP_URL/api/agents/$AGENT_ID" \
    -H "Authorization: Bearer $(cat "$TOKEN_FILE")" | jq '.adapterConfig.env'   # relire avant d'écrire
  curl -sS -X PATCH "$PAPERCLIP_URL/api/agents/$AGENT_ID" \
    -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
    -H 'Content-Type: application/json' \
    -d '{"adapterConfig":{"env":{"HOME":"<valeur-relue>","AGENT_PR_WRAPPER_REQUIRED":"<valeur-relue>","OPENCODE_ALLOW_ALL_MODELS":"false","PAPERCLIP_OPENCODE_SMALL_MODEL":"bifrost/qwen3-coder-30b-sovereign"}}}'
done
```

La sémantique de `OPENCODE_ALLOW_ALL_MODELS=false` côté CLI est UNVERIFIABLE ; la valeur est posée par précaution, la vérification du catalogue (étape 3 bis) fait foi.

3. Retirer le flag cloud et RECRÉER le conteneur. Modifier l'environnement à la source utilisée par le mécanisme de lancement effectif du conteneur (à identifier d'abord : `docker inspect` du conteneur, unité de service ou fichier compose ; ce mécanisme n'a pas été constaté, UNVERIFIABLE) : supprimer `PAPERCLIP_ALLOW_CLOUD_MODELS=1`, supprimer ou corriger `PAPERCLIP_OPENCODE_SMALL_MODEL`, retirer le bloc `openrouter` de `PAPERCLIP_OPENCODE_PROVIDERS`, corriger `PAPERCLIP_LLM_MODE` si le déploiement redevient souverain. Puis recréer le conteneur : `docker restart` conserve l'environnement fixé à la création et laisserait le flag à `1` (retour fictif). Le flag est lu à chaque requête : dès la recréation, tout heartbeat encore configuré sur un modèle cloud échoue (fail-closed, bruyant mais sûr). C'est pourquoi les étapes 2 et 2 bis précèdent l'étape 3.

```bash
# Après recréation, avant toute reprise : le flag doit avoir disparu.
docker exec <conteneur-paperclip> sh -c 'env | grep -c ^PAPERCLIP_ALLOW_CLOUD_MODELS='
# attendu : 0
```

3 bis. Vérifier le catalogue vu par le CLI dans le conteneur recréé : il doit lister `bifrost/qwen3-coder-30b-sovereign` et ne plus lister `opencode-go/`. Un composant hors dépôt régénère la config opencode à partir de l'environnement (UNVERIFIABLE) : cette vérification se fait AVANT la reprise, pas après.

```bash
docker exec <conteneur-paperclip> opencode models | grep -c '^bifrost/qwen3-coder-30b-sovereign$'   # attendu : 1
docker exec <conteneur-paperclip> opencode models | grep -c '^opencode-go/'                          # attendu : 0
```

4. Reprendre les agents.

```bash
for AGENT_ID in <id-q-gov> <id-q-impl> <id-q-web> <id-qa-tests>; do
  curl -sS -X POST "$PAPERCLIP_URL/api/agents/$AGENT_ID/resume" \
    -H "Authorization: Bearer $(cat "$TOKEN_FILE")"
done
```

5. Vérifier les heartbeats (section suivante). Attendre au moins un run `ok` par agent. Critères de sortie : des requêtes du conteneur réapparaissent côté Bifrost ; le dashboard OpenCode affiche zéro requête sur le workspace agents pendant 24 h après reprise.

Ce que la terminaison des 16 agents souverains implique : `POST /api/agents/:id/resume` refuse un agent `terminated` (409, `server/src/services/agents.ts` l.510 — VERIFIED). Le retour de ces rôles passe obligatoirement par `POST /api/companies/:id/agents` (recréation, avec `budgetMonthlyCents > 0` dès la création : ce chemin crée la politique de budget). Ne pas utiliser `DELETE /api/agents/:id` sur les agents terminés : suppression physique, perte de l'historique des runs.

## Vérifications

Aucune commande ci-dessous n'affiche de valeur secrète. Ne jamais faire `env` sans filtre dans le conteneur : les jetons y sont.

Passerelle Bifrost : un appel anonyme doit répondre 401.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "<url-bifrost-locale>/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-coder-30b-sovereign","messages":[{"role":"user","content":"ping"}]}'
# attendu : 401
```

Variables de mode du conteneur (noms non secrets uniquement).

```bash
docker exec <conteneur-paperclip> sh -c 'env | grep -E "^(PAPERCLIP_ALLOW_CLOUD_MODELS|PAPERCLIP_LLM_MODE|OPENCODE_ALLOW_ALL_MODELS|PAPERCLIP_OPENCODE_SMALL_MODEL|PAPERCLIP_DELIVERY_LANE)="'
```

Catalogue de modèles vu par le CLI.

```bash
docker exec <conteneur-paperclip> opencode models | awk -F/ '{print $1}' | sort | uniq -c
# mode cloud : opencode-go présent ; mode souverain visé : seuls bifrost (et openai si OPENAI_BASE_URL) doivent servir
```

Contrôle des modèles et de l'environnement par agent en base. Noms de colonnes VERIFIED sur le schéma du fork à `ca53c5f` (`packages/db/src/schema/agents.ts` : `status`, `adapter_config`, `budget_monthly_cents`, `spent_monthly_cents`).

```sql
SELECT name, status, adapter_config->>'model' AS model,
       adapter_config->'env' AS env,
       budget_monthly_cents, spent_monthly_cents
FROM agents
ORDER BY status, name;
-- après retour : aucun model 'opencode-go/%', aucun env->>'PAPERCLIP_OPENCODE_SMALL_MODEL' contenant 'opencode-go/'
```

Derniers runs par agent. Noms de colonnes VERIFIED (`packages/db/src/schema/heartbeat_runs.ts` : `status`, `created_at`) ; `heartbeat_runs` n'a pas de colonne coût, le coût par run est dans `result_json`.

```sql
SELECT a.name, r.status, r.created_at
FROM heartbeat_runs r JOIN agents a ON a.id = r.agent_id
ORDER BY r.created_at DESC
LIMIT 20;
```

Politiques de budget (doivent exister avec un montant > 0 pour chaque agent actif).

```sql
SELECT * FROM budget_policies;
```

Pose d'un budget avec enforcement réel (la route `PATCH /api/agents/:id` ne crée pas de politique). Valeur : voir ADR-IA-018 D6 (≤ 80 % du plafond Go du modèle tant que le comportement hors plafond n'est pas constaté).

```bash
curl -sS -X PATCH "$PAPERCLIP_URL/api/agents/<agent-id>/budgets" \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  -H 'Content-Type: application/json' \
  -d '{"budgetMonthlyCents":900}'
```

Dashboard fournisseur (session de l'opérateur, non scriptable ici) : dépense du workspace agents, état de « Use balance » (doit être désactivé), comportement hors plafond, plafonds du mois, statut de l'accord ZDR DeepSeek, séparation des clés IDE / agents. Le coût vu par Paperclip est celui déclaré par le CLI ; le dashboard fait foi pour la facture.

Egress : après retour au souverain, Bifrost doit recevoir à nouveau des requêtes du conteneur et le dashboard OpenCode ne doit plus bouger. Avant retour, l'inverse est l'état constaté.

## Rollback

Rollback de la procédure de retour (revenir à l'état cloud du 2026-09-03) :

1. Remettre `PAPERCLIP_ALLOW_CLOUD_MODELS=1` et `PAPERCLIP_OPENCODE_SMALL_MODEL=opencode-go/glm-5.3-flash` à la source de l'environnement utilisée par le mécanisme de lancement, puis RECRÉER le conteneur (pas `docker restart`). Vérifier : `docker exec <conteneur-paperclip> sh -c 'env | grep -c ^PAPERCLIP_ALLOW_CLOUD_MODELS=1$'` renvoie 1.
2. Restaurer la révision de configuration précédente de chaque agent : `POST /api/agents/:id/config-revisions/:revisionId/rollback` (les `PATCH` enregistrent une révision), ou refaire les `PATCH` avec le modèle `opencode-go/...` d'origine et l'objet `env` d'origine.
3. `resume` les agents.

Rollback d'urgence de l'état cloud (couper tout egress cloud sans finesse) : retirer `PAPERCLIP_ALLOW_CLOUD_MODELS` à la source et recréer le conteneur. Tous les heartbeats des agents cloud échouent immédiatement. Puis faire la procédure de retour dans l'ordre.

Sauvegarde préalable recommandée avant toute écriture : export JSON des agents (`GET /api/companies/<company-id>/agents`) et dump de la base embarquée, dans un répertoire hors dépôt.

## Écarts entre le plan et la réalité

Résumé ; le détail avec étiquettes est dans ADR-IA-018 §1.3.

- 20 agents, pas 24. Dyad, agent-0, agent-3, agent-5, agent-9, agent-22 n'existent pas.
- 16 agents souverains `terminated` le 02/09, pas « suspendus » ; `resume` les refuse (409).
- GPU souverain en ligne et inactif : le motif de la bascule est une décision, pas une saturation.
- Bifrost sans provider cloud, sans modèle `role-*` ; egress direct vers `opencode.ai`.
- URL Go = `https://opencode.ai/zen/go/v1`, pas `zen/v1`. Préfixe CLI Go = `opencode-go/`, pas `opencode/`.
- Fallback Groq Kimi K2 inexistant (retiré en 2025). ModelScope : pas 2 000 appels/jour. Z.ai : pas « illimité », et gratuit réservé au non commercial. NVIDIA : tier gratuit interdit en production, clause d'entraînement.
- `PAPERCLIP_LLM_MODE=sovereign`, `PAPERCLIP_OPENCODE_PROVIDERS`, `PAPERCLIP_OPENCODE_SMALL_MODEL` ne sont pas des variables Paperclip (0 occurrence dans le dépôt). Un composant hors dépôt les consomme : à inventorier.
- Budgets à 0, catalogue de 28 modèles ouvert (le plan en câble 5), bloc `openrouter` mort mais déclaré.
