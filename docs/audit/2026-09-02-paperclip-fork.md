# Audit en lecture seule — `haykel1977/paperclip`

- **Date:** 2026-09-02
- **Dépôt audité:** `https://github.com/haykel1977/paperclip`
- **Branche / SHA:** `main` @ `fef2f8f86b05ab32daa37bd86c0c9f7cec57af3a`
- **Agent (auteur de cet audit):** Cursor Cloud Agent `bc-cf6c0ba8-7c65-4c7c-b060-d6f934c09a31` — [run](https://cursor.com/agents/bc-cf6c0ba8-7c65-4c7c-b060-d6f934c09a31)
- **Modèle:** Cursor Grok 4.6 (`cursor-grok-4.6-high-fast`)
- **Méthode:** lecture du code, des schémas, des tests et des docs **dans ce checkout**. Aucune connexion à `paperclip.kantum.dev`. Aucune feature implémentée. Aucun correctif appliqué.

## 0. Périmètre et règles de vérité

Cet audit **ne prétend pas** que l’instance live Kantum est corrigée. Les observations opérateur (image `paperclip:main-e8a4c894`, company Core Banking Factory, erreurs `x-bf-vk`, DELETE 500 live) sont traitées comme **hypothèses** : soit le code de ce dépôt les explique, soit elles restent **uniquement observées live** (non reproduites ici).

Interdits respectés:

- pas d’implémentation de features
- pas d’ADR inventé
- pas de `GO_TOTAL` inventé (chaîne absente de ce dépôt)
- si un secret réel avait été trouvé : fichier + ligne + *kind* seulement (aucun n’a été trouvé)

Convention: chaque affirmation factuelle cite un chemin. Les citations `fichier:ligne` sont relatives à la racine du dépôt.

---

## 1. Identité de ce fork vs upstream

### 1.1 Ce que le git dit

- Remote observé: `origin` → `github.com/haykel1977/paperclip` (fetch/push).
- HEAD: `fef2f8f8` — `chore(lockfile): refresh pnpm-lock.yaml (#97)`.
- Historique récent du fork: durcissement sécurité / gouvernance / deps (`#81`, `#83`, `#86`, `#88`, `#95`), autonomy-witness, Better Auth, lockfile CI.

### 1.2 Ce que les manifests disent encore (upstream)

Le workspace racine n’a **pas** de champ `version` (`package.json:1-4`). Les packages produit sont à **`0.3.1`**:

| Chemin | `name` | `version` |
|--------|--------|-----------|
| `cli/package.json` | `paperclipai` | `0.3.1` |
| `server/package.json` | `@paperclipai/server` | `0.3.1` |
| `ui/package.json` | `@paperclipai/ui` | `0.3.1` |
| `packages/shared/package.json` | `@paperclipai/shared` | `0.3.1` |
| `packages/db/package.json` | `@paperclipai/db` | `0.3.1` |
| `packages/adapter-utils/package.json` | `@paperclipai/adapter-utils` | `0.3.1` |
| `packages/adapters/opencode-local/package.json` | `@paperclipai/adapter-opencode-local` | `0.3.1` |
| `packages/adapters/cursor-local/package.json` | `@paperclipai/adapter-cursor-local` | `0.3.1` |
| `packages/adapters/cursor-cloud/package.json` | `@paperclipai/adapter-cursor-cloud` | `0.3.1` |

Même schéma pour les autres adapters built-in (`claude-local`, `codex-local`, `gemini-local`, `grok-local`, `pi-local`, `acpx-local`, `openclaw-gateway`) et `packages/skills-catalog`. Les packages plugins / MCP restent souvent à `0.1.0` (ex. `packages/mcp-server/package.json`).

Les URLs `repository` des packages pointent **upstream** `https://github.com/paperclipai/paperclip` (ex. `cli/package.json:17-20`). Aucun `package.json` ne cite `haykel1977/paperclip`.

### 1.3 README, licence, docs publiques

- `README.md` se présente comme le produit Paperclip upstream: badge MIT vers `paperclipai/paperclip` (`README.md:15`), clone `git clone https://github.com/paperclipai/paperclip.git` (`README.md:300-301`), issues/discussions upstream (`README.md:411-412`). **Aucune** mention de `haykel1977`, `HenkDz`, Kantum, ni `0.3.x`.
- `LICENSE`: MIT, `Copyright (c) 2025 Paperclip AI` (`LICENSE:1-3`).
- Footer README: `MIT © 2026 Paperclip Labs, Inc` (`README.md:418`) — titulaire / année différents du fichier `LICENSE`.
- `CONTRIBUTING.md:69` et `SECURITY.md:5-6` envoient vers `paperclipai/paperclip`.
- `releases/v0.3.1.md:1-3` date la release `0.3.1` au **2026-03-12**. `releases/` contient aussi une ligne `v2026.*` (ex. `releases/v2026.529.0.md`) — **dérive de versionnement** entre manifests `0.3.1` et notes `v2026.*`.
- `docker/Dockerfile.onboard-smoke:4` pin `PAPERCLIPAI_VERSION=0.3.1`.

### 1.4 `AGENTS.md` §12 décrit un *autre* fork

`AGENTS.md:195-197` s’intitule **« Fork-Specific: HenkDz/paperclip »** et pointe `feat/externalize-hermes-adapter`. Ce n’est **pas** le remote `haykel1977/paperclip`. Les QoL UI cités (`stderr_group`, `tool_group`, excerpt dashboard) sont présents dans ce checkout (`ui/src/components/transcript/RunTranscriptView.tsx`, `ui/src/pages/AgentDetail.tsx`) — héritage / copie, pas une preuve que ce remote *est* HenkDz.

Hermes n’est **pas** un adapter built-in ici: `server/src/adapters/builtin-adapter-types.ts:4-17` n’inclut pas `hermes_local`. Test: `server/src/__tests__/adapter-routes.test.ts` attend `hermes_local === false`.

### 1.5 Identité fork *réelle* dans ce tree

Présente surtout dans:

- `scripts/dyad-pr-relay.sh` (`GH_REPO="haykel1977/paperclip"`)
- `.github/ISSUE_TEMPLATE/agent_task.yml` (lien `haykel1977/paperclip`)
- `doc/SECURITY-BRANCH-PROTECTION.md`
- `doc/ANTIGRAVITY-PAPERCLIP-HARDENING-PROMPT.md` (runtime `quantum-dev.kantum.dev`, images `main-*`)

### 1.6 `docs/` vs `doc/`

| Dossier | Rôle | Preuve |
|---------|------|--------|
| `docs/` | site Mintlify public | `docs/docs.json`; script `docs:dev` dans `package.json` |
| `doc/` | specs / developing / plans / gouvernance | `AGENTS.md` §2–3 |

`docs/audit/` n’existait pas avant cet audit.

---

## 2. Architecture

### 2.1 Surface produit

Monorepo pnpm (`package.json`, `pnpm-workspace.yaml`):

- `server/` — Express, orchestration, heartbeats
- `ui/` — React + Vite
- `packages/db/` — Drizzle
- `packages/shared/` — types, validators, constantes
- `packages/adapters/*` + `packages/adapter-utils/`
- `packages/plugins/*`, `cli/`, `skills/`

API: préfixe `/api` (`AGENTS.md` §8; `docs/api/overview.md`).

### 2.2 Adapters built-in

`server/src/adapters/builtin-adapter-types.ts:4-17` et `registerBuiltInAdapters()` (`server/src/adapters/registry.ts:404-420`):

`acpx_local`, `claude_local`, `codex_local`, `cursor_cloud`, `cursor`, `gemini_local`, `grok_local`, `openclaw_gateway`, `opencode_local`, `pi_local`, `process`, `http`.

`packages/shared/src/constants.ts:30-42` (`AGENT_ADAPTER_TYPES`) **omet** `grok_local` alors que le registry le charge (`server/src/adapters/registry.ts:414`). Type adapter = union ouverte (`string & {}`).

#### `opencode_local`

- Package: `packages/adapters/opencode-local/`
- Enregistrement: `server/src/adapters/registry.ts:354-371`
- Doc config: `packages/adapters/opencode-local/src/index.ts:78-120`
- `dangerouslySkipPermissions` défaut **true** (`packages/adapters/opencode-local/src/server/runtime-config.ts:39`; doc `index.ts:98`)
- Env runtime: `{ ...process.env, ...preparedRuntimeConfig.env }` (`packages/adapters/opencode-local/src/server/execute.ts:367-371`)
- `copyOpenAiSovereignEnv` ne copie `OPENAI_API_KEY` / base URL **que si la cible est vide** (`execute.ts:93-99`, `372`) — l’env agent **gagne** sur l’hôte
- `refreshPaperclipWorkspaceEnvForExecution` écrit `envConfig` par-dessus `input.env` (`packages/adapter-utils/src/server-utils.ts:1207-1209`)

#### `cursor` (local)

- Type registry: **`cursor`**, pas `cursor_local` (`server/src/adapters/registry.ts`)
- Pas de champ `dangerouslySkipPermissions`; injection `--yolo` sauf si `--trust`/`--yolo`/`-f` déjà dans `extraArgs` (`packages/adapters/cursor-local/src/server/execute.ts:351`, `592`)

#### `cursor_cloud`

- Schéma: `packages/adapters/cursor-cloud/src/server/index.ts`
- Env: `configEnv` puis env Paperclip; `CURSOR_API_KEY` retiré de l’env SDK (`packages/adapters/cursor-cloud/src/server/execute.ts`)

#### `http`

- Doc: `docs/adapters/http.md`
- Exécution: `fetch(url)` serveur avec `config.url` + headers libres (`server/src/adapters/http/execute.ts:4-27`)
- **N’utilise pas** `adapterConfig.env`

Plugins externes peuvent override un built-in (`server/src/adapters/registry.ts`). Type inconnu → fallback `process` (`registry.ts` autour de `getServerAdapter`).

`detectModel`: helper registry + route `GET /api/companies/:companyId/adapters/:type/detect-model` (`server/src/routes/agents.ts`). Aucun package `packages/adapters/*` n’implémente `detectModel` (grep).

### 2.3 Heartbeat

- Timer: `setInterval` → `heartbeat.tickTimers()` (`server/src/index.ts:767-777`)
- `tickTimers` enqueue `source: "timer"`, `reason: "heartbeat_timer"` (`server/src/services/heartbeat.ts`)
- Autres wakes: `POST /api/agents/:id/wakeup`, invoke legacy, checkout, routines, recovery, monitors
- Raisons exemptées de cooldown: `server/src/services/heartbeat.ts:239-253`
- Checkout **ne choisit pas** le workspace; le heartbeat réalise le cwd après (`heartbeat.ts` ~7926+)

### 2.4 Hire / approve / reject

Hire (`server/src/routes/agents.ts:2311-2360`):

1. `company.requireBoardApprovalForNewAgents` → status `pending_approval` sinon `idle`
2. `svc.create(...)` **toujours** (nouvel agent)
3. Si approval requise: `approvalsSvc.create` type `hire_agent` avec `payload.agentId: agent.id`

Approve (`server/src/services/approvals.ts:112-166`): `activatePendingApproval(payload.agentId)` ou create legacy si pas d’`agentId`.

Reject (`server/src/services/approvals.ts:171-185`):

```
if (applied && updated.type === "hire_agent") {
  ...
  if (payloadAgentId) {
    await agentsSvc.terminate(payloadAgentId);
  }
}
```

**Uniquement** `payload.agentId`. Pas de recherche par nom. `agentsSvc.terminate` (`server/src/services/agents.ts:529-548`) pose `status: terminated` et révoque les clés — **sans** passer par la route `POST /terminate` (donc **sans** `listInvalidOrgChainDescendantIds` / `cancelInvocationsForAgents`).

Noms: `deduplicateAgentName` à la création; les terminated sont exclus des collisions de shortname (`server/src/services/agents.ts:197-198`).

**Hypothèse opérateur** « reject d’un hire pending a terminé des agents idle *du même nom* »: **non implémenté dans ce dépôt**. Voir §8.

### 2.5 Agent PATCH

`updateAgentSchema` (`packages/shared/src/validators/agent.ts:104-112`): partial create + `replaceAdapterConfig`, `status`, `spentMonthlyCents`. **Pas** de `executionWorkspacePreference` / `workspaceStrategy` top-level.

`workspaceStrategy` peut vivre dans `adapterConfig` JSONB (`packages/db/src/schema/agents.ts`). Merge profond sauf `replaceAdapterConfig: true` (`server/src/routes/agents.ts`).

Un agent **ne peut pas** self-PATCH `adapterConfig.env`, `cwd`, `dangerouslySkipPermissions`, etc. (`server/src/routes/agents.ts:1402-1428`).

### 2.6 Terminate et DELETE

| Action | Route | Service |
|--------|-------|---------|
| Terminate | `POST /api/agents/:id/terminate` `server/src/routes/agents.ts:3100-3149` | `svc.terminate` + cancel heartbeats agent + descendants org-chain invalides |
| Delete | `DELETE /api/agents/:id` `server/src/routes/agents.ts:3152-3174` | `svc.remove` |

Liste par défaut **exclut** `terminated` (`server/src/services/agents.ts:448-452`). Un terminate suffit à faire « disparaître » l’agent de la liste, même si DELETE échoue.

`remove()` (`server/src/services/agents.ts:551-581`) nettoie: `reportsTo` enfants, assignees/créateurs d’issues, `heartbeatRunEvents`, `agentTaskSessions`, `activityLog` lié, `issueExecutionDecisions`, `issueComments`, `heartbeatRuns`, `agentWakeupRequests`, `agentApiKeys`, `agentRuntimeState`, puis delete agent.

**FK `agents.id` sans `onDelete: cascade` et non nettoyées par `remove()`** (liste non exhaustive):

| Table | Colonne | Fichier |
|-------|---------|---------|
| `cost_events` | `agentId` NOT NULL | `packages/db/src/schema/cost_events.ts:14` |
| `finance_events` | `agentId` | `packages/db/src/schema/finance_events.ts:15` |
| `approvals` | `requestedByAgentId` | `packages/db/src/schema/approvals.ts:11` |
| `projects` | `leadAgentId` | `packages/db/src/schema/projects.ts:16` |
| `routines` | `assigneeAgentId` | `packages/db/src/schema/routines.ts:32` |
| `issue_thread_interactions` | `createdByAgentId` / `resolvedByAgentId` | `packages/db/src/schema/issue_thread_interactions.ts:27-29` |
| `goals` | `ownerAgentId` | `packages/db/src/schema/goals.ts:22` |
| `assets` | `createdByAgentId` | `packages/db/src/schema/assets.ts:16` |
| `approval_comments` | `authorAgentId` | `packages/db/src/schema/approval_comments.ts:12` |
| `join_requests` | `createdAgentId` | `packages/db/src/schema/join_requests.ts:25` |

Un agent qui a déjà produit des `cost_events` (cas typique après runs) peut donc faire **500** au DELETE. Aucun test d’intégration server trouvé pour delete-après-terminate + FK. Le test CLI (`cli/src/__tests__/agent-lifecycle.test.ts`) mock le HTTP seulement.

### 2.7 Checkout

Validateur (`packages/shared/src/validators/issue.ts:460-463`):

```ts
agentId: z.string().uuid(),
expectedStatuses: z.array(z.enum(ISSUE_STATUSES)).nonempty(),
```

Route (`server/src/routes/issues.ts:5675-5720`): company access; agent ne peut checker que soi-même; `requireAgentRunId` obligatoire pour un acteur agent; `svc.checkout(...)`.

**Hypothèse opérateur confirmée dans ce repo:** le body exige `agentId` + `expectedStatuses` non vide.

---

## 3. Execution workspaces

### 3.1 Modèle

Deux couches:

- **Project workspace** — `project_workspaces` (`packages/db/src/schema/project_workspaces.ts`): `cwd`, `repoUrl`, `sharedWorkspaceKey`
- **Execution workspace** — `execution_workspaces` (`packages/db/src/schema/execution_workspaces.ts:23-31`): `mode`, `strategyType`, `cwd`, `branchName`, …

Côté issue (`packages/db/src/schema/issues.ts:61-64`): `executionWorkspaceId`, `executionWorkspacePreference`, `executionWorkspaceSettings` (JSONB).

`workspaceStrategy` n’est **pas** une colonne issue. Elle vit dans `executionWorkspaceSettings`, `projects.executionWorkspacePolicy`, et/ou `agents.adapterConfig`.

Préférences (`packages/shared/src/validators/issue.ts:98-105`): `inherit`, `shared_workspace`, `isolated_workspace`, `operator_branch`, `reuse_existing`, `agent_default`.

### 3.2 Défaut = `shared_workspace`

`resolveExecutionWorkspaceMode` (`server/src/services/execution-workspace-policy.ts:278-297`):

1. mode issue si ≠ `inherit` / `reuse_existing`
2. sinon policy projet (`isolated_workspace` / `operator_branch` / `adapter_default` → `agent_default` / sinon `shared_workspace`)
3. sinon `useProjectWorkspace === false` → `agent_default`
4. sinon **`shared_workspace`**

`git_worktree` n’est attaché que si mode `isolated_workspace` (`execution-workspace-policy.ts:315-325`). Défaut stratégie isolated: `{ type: "git_worktree" }`. Sinon `workspaceStrategy` est **supprimé** du config adapter.

Low-trust review peut forcer isolated même si shared (`server/src/services/heartbeat.ts:8022-8025`).

### 3.3 Checkout ≠ choix de workspace

`issueService.checkout` assigne + `in_progress` + locks (`server/src/services/issues.ts`). La réalisation worktree est dans le heartbeat (`realizeExecutionWorkspace`, `workspace-runtime.ts`).

### 3.4 Branche / concurrence

- Template défaut: `{{issue.identifier}}-{{slug}}` (`server/src/services/workspace-runtime.ts:1136`)
- Parent worktree défaut: `<repo>/.paperclip/worktrees` (`workspace-runtime.ts:1146-1148`)
- **Pas** de préfixe `paperclip/*` dans le code
- Locks = **par issue** (checkout atomique), **pas** de mutex git sur le clone partagé. Plusieurs issues `shared_workspace` peuvent partager le même `project_workspaces.cwd`.

### 3.5 Pourquoi un PATCH `isolated_workspace` / `git_worktree` peut « ne pas persister »

Flag expérimental **`enableIsolatedWorkspaces` défaut `false`** (`server/src/services/instance-settings.ts:45-58`).

Sur create **et** update issue, si le flag est off (`server/src/services/issues.ts:4704-4708` et `4962-4967`):

```
delete issueData.executionWorkspaceId;
delete issueData.executionWorkspacePreference;
delete issueData.executionWorkspaceSettings;
```

Le PATCH Zod accepte les champs (`packages/shared/src/validators/issue.ts:406-408`, `446`) et peut renvoyer **200** — les colonnes workspace ne sont **pas écrites**.

Heartbeat: si flag off, `issueExecutionWorkspaceSettings` est forcé `null` (`heartbeat.ts:7927-7929`) et `gateProjectExecutionWorkspacePolicy` retourne `null` (`execution-workspace-policy.ts:85-90`). Même une policy projet `enabled` est ignorée.

UI: `IssueWorkspaceCard` n’édite que si `enableIsolatedWorkspaces === true` **et** `project.executionWorkspacePolicy.enabled` (`ui/src/components/IssueWorkspaceCard.tsx:215-216`).

**Ceci explique, dans ce repo, l’hypothèse « PATCH isolated / git_worktree n’a pas persisté »** — si l’instance n’a pas le flag expérimental (défaut). L’état live Kantum n’a pas été lu.

### 3.6 Inheritance

`inheritExecutionWorkspaceFromIssueId` (`packages/shared/src/validators/issue.ts:394`; `server/src/services/issues.ts` ~4729-4763). Source: ce champ ou `parentId`. Ignoré si le caller pose déjà id/preference/settings. Tests: `server/src/__tests__/issues-service.test.ts`.

### 3.7 Docs vs code

- `doc/SPEC-implementation.md` liste les colonnes issue — OK
- `doc/DATABASE.md` ne documente pas `execution_workspaces`
- `docs/guides/board-operator/execution-workspaces-and-runtime-services.md` décrit le modèle et le contrat « no remote git » (`docs/guides/board-operator/execution-workspaces-and-runtime-services.md:67-74`)
- `doc/plans/workspace-product-model-and-work-product.md` **rejette** le forçage « 1 issue = 1 workspace = 1 PR »

---

## 4. Sécurité

### 4.1 Secrets dans le tree

Aucun `.pem` live. Exemples:

- `.env.example:1-4` — placeholders DB / Better Auth (kind: secret de dev placeholder)
- `docker/docker-compose.yml` — mot de passe Postgres d’exemple (kind: password compose example)
- Tests / storybook: tokens factices allowlistés (`.gitleaks.toml:1-20`)

Commit de scrub: `96e1701c`. CI gitleaks: `.github/workflows/secret-scan.yml`.

Scanner PR `.github/scripts/check-pr-security.mjs:8`: **exit toujours 0** (« never block the PR visibly »).

### 4.2 Auth

- Agent keys: SHA-256 at rest (`server/src/services/agents.ts`; `packages/db/src/schema/agent_api_keys.ts`)
- Board keys: SHA-256 + compare timing-safe (`server/src/services/board-auth.ts`)
- Actor lié au `companyId` de la clé (`server/src/middleware/auth.ts`; `server/src/routes/authz.ts`)
- `local_trusted`: board implicite, **pas de login** (`server/src/middleware/auth.ts:25-34`; `docs/deploy/deployment-modes.md:8-16`)
- Image Docker défaut: `PAPERCLIP_DEPLOYMENT_MODE=authenticated` + `private` (`Dockerfile:87-88`) — plus strict que le défaut doc `local_trusted`

Logs: `Authorization` redacté (`server/src/middleware/logger.ts:32`); redaction events (`server/src/redaction.ts`).

### 4.3 Path / cwd

- Bundles d’instructions: rejet `..`, resolve dans le root (`server/src/services/agent-instructions.ts:114-141`)
- Storage local: traversal bloqué (`server/src/storage/local-disk-provider.ts`)
- Adapter `cwd`: doit être **absolu** seulement (`packages/adapter-utils/src/server-utils.ts` ~1366-1399) — **pas** borné à un root company

### 4.4 SSRF

`server/src/adapters/http/execute.ts:19-27`: `fetch(url)` sans allowlist. `docs/adapters/http.md` ne mentionne aucun contrôle d’hôte. Probes readiness workspace: fetch d’URL opérateur (`server/src/services/workspace-runtime.ts` ~1913-1934).

### 4.5 `dangerouslySkipPermissions`

- UI create: `true` (`ui/src/components/agent-config-defaults.ts:11`)
- OpenCode / Claude runtime: `true` si unset
- Documenté comme voulu pour headless (`releases/v0.3.1.md:33`)
- Cursor local: `--yolo` auto

### 4.6 `OPENAI_API_KEY` vs Bifrost / `x-bf-vk`

**Dans ce repo:**

- `adapterConfig.env.OPENAI_API_KEY` (plain ou secret_ref) est résolu (`server/src/services/secrets.ts`) puis **écrase** `process.env` pour OpenCode (`packages/adapters/opencode-local/src/server/execute.ts:367-371`)
- Empty override traité comme manquant (`server/src/__tests__/opencode-local-adapter-environment.test.ts`)
- Grep `Bifrost`, `x-bf-vk`, `virtualKey`: **zéro match**

L’erreur live `x-bf-vk` (clé non-VK qui masque une virtual key conteneur) est **cohérente** avec l’ordre de merge, mais **Bifrost n’existe pas dans ce code**. Reste **observé live**.

---

## 5. CI, Docker, supply chain

### 5.1 Workflows (`.github/workflows/`)

`pr.yml`, `docker.yml`, `release.yml`, `e2e.yml`, `secret-scan.yml`, `release-smoke.yml`, `refresh-lockfile.yml`, `paperclip-checker.yml`, `commitperclip-review.yml`, `autonomy-witness.yml`, `autonomy-witness-red.yml`.

Pin SHA observé sur checker / witness / commitperclip (ex. `actions/checkout@df4cb1c0…` dans `paperclip-checker.yml:101`).

Majorité des lanes (dont `pr.yml:21`, `docker.yml:23-47`) : **tags flottants** `@v6`, `@v4`, `@v7`.

`pr.yml` bloque l’édition manuelle de `pnpm-lock.yaml` et exécute `scripts/check-no-git-push.mjs`.

### 5.2 Docker / tags

- `Dockerfile`: `node:24.11.1-trixie-slim`, user `node`, volume `/paperclip`, port 3100
- Push: `ghcr.io/${{ github.repository }}` avec `latest` (default branch), semver, `type=sha` (`.github/workflows/docker.yml:38-44`)
- **Aucune** chaîne `paperclip:main-*` dans le repo. Le tag opérateur `paperclip:main-e8a4c894` est une **convention de déploiement live**, pas un output de ce workflow.

`doc/ANTIGRAVITY-PAPERCLIP-HARDENING-PROMPT.md:25-26` parle d’images `main-b32ac930` / SHA immuable sur `quantum-dev.kantum.dev` — contexte opérateur, pas vérifié ici.

### 5.3 Overrides pnpm

`package.json:71-101`: patch `embedded-postgres`; overrides rollup / nanoid / vite / undici / etc.

---

## 6. `AGENT_PR_WRAPPER_REQUIRED` et wrappers PR

Grep repo-wide: **`AGENT_PR_WRAPPER_REQUIRED` absent**.

Ce qui existe à la place:

| Mécanisme | Chemin | Rôle |
|-----------|--------|------|
| Interdit `git push` dans adapters/runtime | `scripts/check-no-git-push.mjs:1-18` | opt-in `paperclip:allow-git-push` |
| Delivery hook (commit / push / PR) | `packages/adapter-utils/src/delivery-hook.ts:853-868` | labels `agent-pr`; env `PAPERCLIP_DELIVERY_ADR_REF` défaut **chaîne** `"ADR-GOV-007"` (pas un document créé par cet audit) |
| Contrat prompt PR | `packages/adapter-utils/src/server-utils.ts:113-136` | readiness / URL PR dans la MAJ, **pas** un binaire wrapper |
| Usine agent-PR | `doc/AGENT-PR-FACTORY.md` | gouvernance merge, pas env `AGENT_PR_WRAPPER_REQUIRED` |
| CI label | `.github/scripts/enable-agent-automerge.mjs` | `AGENT_PR_LABEL = 'agent-pr'` |

**Hypothèse opérateur:** le flag est **hors de ce dépôt** (env d’hôte / outillage externe). Non implémenté ici.

---

## 7. Instructions, skills, `AGENTS.md`

### 7.1 Bundles managés

`server/src/services/agent-instructions.ts`:

- modes `managed` / `external` (`:6-28`, `:133-141`)
- entry défaut `AGENTS.md` (`:6`)
- root instance `…/companies/{companyId}/agents/{agentId}/instructions`
- traversal protégé; `promptTemplate` / `bootstrapPromptTemplate` dépréciés (`:11-13`)

Adapters locaux lisent `instructionsFilePath` et injectent au execute (ex. cursor-local, claude-local + skills).

### 7.2 Skills

- Repo: `skills/paperclip/`, `skills/paperclip-create-agent/`, `skills/paperclip-dev/` (+ copies `.claude/skills/`)
- Catalog: `packages/skills-catalog/`
- Company skills: `server/src/services/company-skills.ts` (audit statique exfil ~1703+)
- Teams: `packages/teams-catalog/` — pod `product-engineering` = CTO + senior-coder + QA (`packages/teams-catalog/catalog/bundled/software-development/product-engineering/TEAM.md:36-38`)

### 7.3 Rôles

`AGENT_ROLES` (`packages/shared/src/constants.ts:45-61`): `ceo`, `cto`, `cmo`, `cfo`, `security`, `engineer`, `code_reviewer`, `issue_triage`, `planner`, `designer`, `pm`, `qa`, `devops`, `researcher`, `general`. **Pas** de rôle `orchestrator`.

---

## 8. Écarts vs usine 4 rôles (cible opérateur)

Cible demandée (à vérifier, pas à implémenter):

1. l’orchestrateur ne code pas
2. 1 issue = 1 worktree = 1 branche = 1 implémenteur
3. pas d’auto-validation
4. `done` ssi commit / URL de PR

| Règle | Dans ce repo | Preuve |
|-------|--------------|--------|
| Orchestrateur ne code pas | **Absent** comme invariant produit | pas de matcher; rôles libres; team pack optionnel seulement (`TEAM.md`) |
| 1:1:1:1 | **Assignee unique oui**; worktree/branche **opt-in** | `doc/SPEC-implementation.md`; défaut `shared_workspace`; plan anti-1:1:1 (`doc/plans/workspace-product-model-and-work-product.md`) |
| Pas d’auto-validation | **Absent** comme règle globale | skill `done` = travail + vérif (`skills/paperclip/SKILL.md`); QA séparé seulement si pack installé |
| `done` ssi PR URL | **Absent** comme gate serveur | prompt « include PR URL if one exists » (`packages/adapter-utils/src/server-utils.ts:131-135`); aucun prédicat SQL/route |

Paperclip V1 reste un **control plane multi-agents générique**, pas une usine 4 rôles kantum-spécifique.

---

## 9. Hypothèses opérateur — verdict

| Hypothèse | Verdict | Preuve |
|-----------|---------|--------|
| Live = Paperclip 0.3.1 / image `paperclip:main-e8a4c894` / API :3100 | **Versions 0.3.1 dans ce repo.** Tag `paperclip:main-*` **absent** du workflow Docker. Host/image live **non vérifiés**. | manifests `0.3.1`; `.github/workflows/docker.yml:38-44`; `Dockerfile:92` EXPOSE 3100 |
| Company Core Banking Factory + `opencode_local` + cwd git partagé + `mode=shared_workspace` | **Cohérent avec le défaut code** (`shared_workspace`, pas de lock repo). Company/projet live **non lus**. | `execution-workspace-policy.ts:296`; `workspace-runtime.ts` |
| PATCH `executionWorkspacePreference=isolated_workspace` / `workspaceStrategy git_worktree` n’a pas persisté | **Mécanisme in-repo:** flag `enableIsolatedWorkspaces` défaut false → champs **silencieusement droppés**; heartbeat ignore settings/policy. | `instance-settings.ts:58`; `issues.ts:4962-4967`; `heartbeat.ts:7927-7972` |
| `DELETE /api/agents/{id}` souvent 500 après terminate; l’agent quitte la liste | **Mécanisme in-repo:** liste cache `terminated`; `remove()` rate des FK (`cost_events`, etc.). 500 live **non reproduits ici**. | `agents.ts:448-452`, `551-581`; `cost_events.ts:14` |
| Reject hire termine des idle **du même nom** | **Pas dans ce code.** Reject = `terminate(payload.agentId)` seulement. Confusion plausible: le pending (même nom / suffixe) passe terminated et sort de la liste. | `approvals.ts:179-184` |
| `adapterConfig.env.OPENAI_API_KEY` override la VK conteneur → `x-bf-vk` | **Override env: oui.** **Bifrost / `x-bf-vk`: absent de ce repo.** | `opencode-local/.../execute.ts:367-371`; grep vide |
| Checkout exige `agentId` + `expectedStatuses` | **Oui.** | `packages/shared/src/validators/issue.ts:460-463` |
| `AGENT_PR_WRAPPER_REQUIRED` | **Absent** de ce dépôt. | grep vide |

---

## 10. Findings P0 / P1

Séparation obligatoire: **dans ce repo** vs **seulement observé live**.

### 10.1 Dans ce repo

#### P0

1. **SSRF adapter `http`.** `fetch` serveur vers URL + headers configurables, sans allowlist. `server/src/adapters/http/execute.ts:6-27`. Doc: `docs/adapters/http.md:21-24`.

#### P1

1. **`DELETE /agents/:id` incomplet vs FK.** `server/src/services/agents.ts:551-581` vs `packages/db/src/schema/cost_events.ts:14` (et approvals / projects / routines / interactions / goals / assets). Explique un 500 post-terminate **si** l’agent a des lignes liées.

2. **Champs workspace issue droppés si expérimental off.** `server/src/services/issues.ts:4962-4967`; défaut `server/src/services/instance-settings.ts:58`. PATCH peut « réussir » sans écrire.

3. **Policy projet isolated aussi gated.** `gateProjectExecutionWorkspacePolicy` → `null` si flag off (`server/src/services/execution-workspace-policy.ts:85-90`).

4. **Env agent écrase l’env process** (OpenCode, pattern cursor-local). `packages/adapters/opencode-local/src/server/execute.ts:367-371`. Risque si l’hôte compte sur une clé injectée (VK, etc.).

5. **`dangerouslySkipPermissions` / `--yolo` par défaut.** `ui/src/components/agent-config-defaults.ts:11`; adapters OpenCode/Claude/Cursor.

6. **`cwd` adapter non sandboxé** au root company. `packages/adapter-utils/src/server-utils.ts` (absolu seulement).

7. **Actions GitHub majoritairement non pinées SHA.** `.github/workflows/pr.yml:21`; `.github/workflows/docker.yml:23-47`.

8. **Scanner secrets PR non bloquant.** `.github/scripts/check-pr-security.mjs:8`.

9. **`local_trusted` = board implicite.** `server/src/middleware/auth.ts:25-34`. Dangereux si exposé hors loopback.

10. **Identité fork / version dérivée.** README/packages = `paperclipai` + `0.3.1`; `AGENTS.md` §12 = HenkDz; `releases/v2026.*` vs manifests. Risque ops (mauvaise image, mauvais docs).

### 10.2 Seulement observé live (non vérifié ici)

- Instance `paperclip.kantum.dev`, container `paperclip-quantum-dev`, image `paperclip:main-e8a4c894`
- Company « Core Banking Factory », agents `opencode_local`, cwd unique, `mode=shared_workspace` **sur cette instance**
- DELETE 500 **constaté** sur cet hôte (le code *peut* le produire; pas de trace live dans cet audit)
- Reject hire ayant **effectivement** terminé d’autres idle same-name (code ne le fait pas; si vu live: autre cause ou méprise UI)
- Erreurs `x-bf-vk` / Bifrost (zéro code Bifrost ici)
- Flag hôte `AGENT_PR_WRAPPER_REQUIRED`

**Cet audit ne change rien au runtime Kantum.**

---

## 11. P2 / dette (in-repo, non bloquant pour ce livrable)

- Pas de test server delete-après-terminate / FK
- `http` ignore `adapterConfig.env`
- Built-ins sans `detectModel`
- `AGENT_ADAPTER_TYPES` vs `grok_local` built-in
- `doc/DATABASE.md` sans tables execution workspace
- Delivery hook: défaut string `ADR-GOV-007` (`packages/adapter-utils/src/delivery-hook.ts:862`) — **référence existante**, pas un ADR rédigé ici
- Probes HTTP readiness workspace sans politique SSRF documentée

---

## 12. Ce qui n’a pas été fait

- Pas de déploiement, pas de PATCH live, pas de prétention « Kantum fixed »
- Pas d’ADR, pas de `GO_TOTAL`
- Pas de `pnpm test` / typecheck / build (livrable = markdown d’audit; aucun runtime produit n’a changé)
- Pas d’accès navigateur à `paperclip.kantum.dev`
- Instance settings live (`enableIsolatedWorkspaces`) inconnues

---

## 13. Carte des chemins (index)

```
package.json, cli/package.json, server/package.json, ui/package.json, LICENSE, README.md, AGENTS.md
releases/v0.3.1.md, Dockerfile, docker/docker-compose.yml, .env.example, .gitleaks.toml
.github/workflows/{pr,docker,secret-scan,paperclip-checker}.yml
.github/scripts/check-pr-security.mjs
scripts/check-no-git-push.mjs
server/src/index.ts
server/src/adapters/{builtin-adapter-types,registry,http/execute}.ts
server/src/middleware/{auth,logger}.ts
server/src/routes/{agents,issues,authz}.ts
server/src/services/{agents,approvals,issues,heartbeat,instance-settings,
  execution-workspace-policy,workspace-runtime,agent-instructions,secrets,board-auth}.ts
packages/db/src/schema/{agents,issues,execution_workspaces,project_workspaces,
  projects,cost_events,approvals,routines}.ts
packages/shared/src/{constants,validators/agent,validators/issue}.ts
packages/adapters/opencode-local/src/{index,server/execute,server/runtime-config}.ts
packages/adapters/cursor-local/src/server/execute.ts
packages/adapters/cursor-cloud/src/server/execute.ts
packages/adapter-utils/src/{server-utils,delivery-hook}.ts
ui/src/components/{agent-config-defaults,IssueWorkspaceCard}.tsx
skills/paperclip/SKILL.md
packages/teams-catalog/catalog/bundled/software-development/product-engineering/TEAM.md
docs/adapters/http.md
docs/guides/board-operator/execution-workspaces-and-runtime-services.md
docs/deploy/deployment-modes.md
doc/SPEC-implementation.md
doc/ANTIGRAVITY-PAPERCLIP-HARDENING-PROMPT.md
```
