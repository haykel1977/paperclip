---
title: "ADR-IA-018 Mode cloud R&D"
summary: "Déviation documentée à la doctrine souveraine pour les agents Paperclip de développement. Signature de l'opérateur requise ; sans signature, cette ADR n'autorise rien."
---

> Language: French — operator-facing deviation record. English summary: this ADR documents, and does not authorize, a deviation from the sovereign-only doctrine of the private quantum repository: four development-only Paperclip agents run on OpenCode Go cloud models with a checkout of the quantum source tree as working directory, egressing directly to `opencode.ai`. It fixes the scope, the exact provider and models, what leaves the host, the compensating controls, the expiry and the return-to-sovereign procedure. It has no effect until the operator signs §9 in a GitHub-verified commit.

> Ce document décrit une déviation. Il ne l'autorise pas. Sans la signature de l'opérateur au bas de cette page, cette ADR n'autorise rien.
> Convention d'étiquetage : VERIFIED = constaté à la source le 2026-09-03 ; REFUTED = la source dit autre chose ; UNVERIFIABLE = aucune source ne permet de trancher ; PROPOSED = proposition non décidée ; BACKEND-WIRED = mécanisme présent dans le code lu, non exercé ni constaté en live.

| Champ | Valeur |
|---|---|
| **Status** | PROPOSED |
| **Statut du texte vs état du live** | PROPOSED qualifie ce texte. L'état live (agents sur modèles cloud, au plus tard depuis le 2026-09-02) est une déviation non couverte tant que la signature manque. |
| **Transition de statut** | À la signature, l'opérateur remplace lui-même `PROPOSED` par `ACCEPTED-DEV` (taxonomie ADR quantum) dans le commit qui porte la signature, dans cette même PR, avant tout merge. Toute exclusion ou modification signée est reportée dans D1 à D10 dans ce même commit. Jamais `ACCEPTED-PROD` ; jamais `Accepted` nu. |
| **Type** | Déviation temporaire, à visage découvert. Ce que la signature est et n'est pas : voir §9. |
| **Date** | 2026-09-03 |
| **Owner / Decider** | Haykel Ben Amara (opérateur) |
| **Rédaction** | agent (Claude, assistant opérateur). L'agent rédacteur n'approuve rien. |
| **Scope** | Company Paperclip « Core Banking Factory » ; quatre agents nommés (Q-Gov, Q-Impl, Q-Web, QA-Tests) ; dépôt quantum, branches de développement ; aucune donnée de production, de client ou de tenant. |
| **Production verdict** | NO_GO. Aucune donnée, aucune charge, aucun tenant de production dans le périmètre. |
| **Supersedes / Superseded-by** | aucun / — |
| **Relates** | ADR-IA-017 (registre des modèles souverains), ADR-ARCH-003 (architecture centrée GPU souverain), ADR-SEC-010 (gouvernance tiers ICT / DORA), ADR-GOV-015 (posture dev full-auto ; §5 jalon « GO production migration »), ADR-GOV-026 (gates jamais dégradés), ADR-0042B (périmètres META / GREY) |
| **Deviates-from** | CLAUDE.md doctrine 2 (« Sovereign LLM uniquement »), doctrine 3 (résidence EU/Algérie), doctrine 4 (fail-closed : l'état live est permissif, à corriger, §4) ; RULE-PROV-003 par l'esprit (la lettre, `store.go` et migrations, n'est pas touchée) ; ADR-GOV-015 §2 « Zero frontier runtime … only » (doctrine dev active, ACCEPTED-DEV) ; ADR-ARCH-003 §drivers et table rôles → GPU souverain (ACCEPTED) ; ADR-SEC-010 et `docs/compliance/ict-register.yaml` (assertion « cloud egress disabled and EU data residency asserted », fausse au plus tard depuis le 2026-09-02) ; `docs/governance/llm-model-allowlist.yml` règles `allowlist-only` et `no-cloud-egress` ; `docs/SSOT/HUMAN_GATES.md` l.38 (« aucun cloud externe autorisé sans approbation explicite » ; condition remplie par la signature §9, pour ce périmètre seulement) ; `docs/SSOT/PR_REVIEW_RULES.md` l.134 (« An exception cannot authorize … cloud egress bypass » : contradiction ouverte, §8.6). Aucune de ces règles n'est amendée par cette ADR ; chaque amendement passe par une PR quantum (§8). |
| **Numéro** | 018. Libre dans quantum au 2026-09-03 (VERIFIED : aucun fichier `*IA-018*` dans `docs/adr/` ni `docs/architecture/adrs/`). La réservation est une décision de cette ADR, matérialisée par le miroir (§8.5). |
| **Expiry** | 2026-12-02, sauf nouvelle signature datée de l'opérateur avant cette date (D10.5). Fin anticipée selon D9 (première condition survenue). Réévaluation possible à tout moment avant. |

## 1. Contexte

### 1.1 Décision de l'opérateur (verbatim, 2026-09-03)

« pour développer quantum je fais comme ça ensuite une fois que quantum sera prêt j'y mettrai des agents souverains »

Option retenue par l'opérateur : « garder le cloud sur dev : alors ça se fait à visage découvert. ADR de déviation (pas d'approbation), périmètre dev-only, durée, providers exacts, modèles, ce qui sort et vers qui, signé par l'opérateur. »

### 1.2 Ce que cette ADR couvre

Le déploiement Paperclip de développement (`paperclip.kantum.dev`) fait tourner quatre agents sur des modèles cloud OpenCode Go, au plus tard depuis le 2026-09-02 (premier run des agents Q-* ; date exacte du passage aux modèles cloud UNVERIFIABLE). Un checkout du code source du dépôt quantum est leur répertoire de travail. Cet état contredit la doctrine écrite du dépôt quantum. Cette ADR le déclare, le borne et fixe les conditions de retour.

### 1.3 État live constaté le 2026-09-03 contre état supposé par le plan

Le plan de bascule (document de décision « Version du 3 septembre 2026 » et prompt d'exécution associé, fournis par l'opérateur, non publiés) suppose un état de départ qui n'est pas celui constaté. Les écarts sont listés ici parce qu'un plan qui part d'un faux état produit de fausses conclusions.

| Point | Ce que le plan suppose (source) | Ce qui est constaté | Étiquette |
|---|---|---|---|
| Nombre d'agents | 24 agents, dont Dyad, agent-0, agent-3, agent-5, agent-9, agent-22 (prompt d'exécution) | 20 lignes dans la table `agents`. Aucun agent nommé Dyad ni agent-N n'existe. | VERIFIED (SQL live) |
| Agents souverains | 12 agents « suspendus », état conservé, rollback possible (document de décision) | 16 agents `terminated` le 2026-09-02 (13:01 et 13:31 UTC), tous sur `bifrost/qwen3-coder-30b-sovereign`. La route de terminaison révoque les clés API de l'agent (VERIFIED code, R3) ; révocation effective en base non constatée (UNVERIFIABLE). `resume` refuse un agent `terminated` (409, `server/src/services/agents.ts` l.510, VERIFIED). | VERIFIED (SQL live ; code) |
| Motif de la déviation | GPU souverain saturé (« ~90 % de VRAM pour LoRA », rapport tiers) | GPU souverain en ligne : environ 63 % de VRAM occupée (62,6 % ; valeurs brutes nvidia-smi dans le miroir privé), utilisation 0 %, conteneurs vLLM actifs. L'endpoint souverain est disponible et inactif. | VERIFIED (nvidia-smi 2026-09-03 14:05 UTC). Le motif est une décision (coût, sortie du GPU souverain, vitesse : document de décision l.7 « Budget cible : 40 $/mois tout compris »), pas une indisponibilité. |
| Point de sortie | Bifrost = seul point de sortie, providers `go_agents`, `nvidia`, `modelscope`, `zai`, `groq`, modèles virtuels `role-*` (prompt d'exécution) | Bifrost : providers `ollama`, `vllm`, `vllm-embed`. Zéro provider cloud. Zéro modèle `role-*`. 0 requête du conteneur Paperclip depuis 10:30 UTC le 03/09. | VERIFIED |
| Chemin d'egress | conteneur → Bifrost → fournisseur | conteneur → `opencode.ai` (Cloudflare) directement. Le provider `opencode-go` est intégré au binaire opencode 1.17.7 ; Paperclip n'injecte aucun proxy. | VERIFIED par inférence (provider intégré au binaire, aucun proxy configuré, 0 requête Bifrost depuis 10:30 UTC, DNS `opencode.ai` → Cloudflare) ; capture du flux sortant non réalisée (UNVERIFIABLE) |
| Étiquette de mode | non traitée | `PAPERCLIP_LLM_MODE=sovereign` dans l'environnement du conteneur, à côté de modèles cloud. Variable lue par aucun code Paperclip. | VERIFIED (FACTS ; R3 : 0 occurrence) |
| Bloc provider `openrouter` | absent du plan | Déclaré dans l'environnement (modèles `anthropic/claude-*`, `openai/gpt-5*`, `google/gemini-2.5-pro`, `x-ai/grok-4-fast`). Clé retirée le 03/09. 0 appel. Bloc mort mais déclaré. | VERIFIED |
| Budgets | 8 à 10 $ par agent, alerte 80 %, arrêt 100 % (prompt d'exécution, tableau de routage ; document de décision, §« Répartition des 60 $ ») | `budget_monthly_cents = 0` pour les 4 agents. Dans Paperclip, 0 signifie « aucune limite ». | VERIFIED (SQL live ; R3) |
| Catalogue de modèles | 5 modèles Go câblés : `kimi-k2.7-code` (coders), `kimi-k3` (Reviewer), `deepseek-v4-pro` (Planner), `glm-5.3-flash` (QA), `glm-5.3` (Sécurité) ; catalogue non traité (document de décision, tableau de routage et §budget) | 3 ids configurés sur les 4 agents ; `OPENCODE_ALLOW_ALL_MODELS=true` : 28 modèles `opencode-go/*` sélectionnables par l'API, dont `grok-4.6` et `gpt-5.6-luna`. | VERIFIED |
| URL d'API Go | `https://opencode.ai/zen/v1`, annotée « à confirmer » dans le plan | Go = `https://opencode.ai/zen/go/v1`. `zen/v1` est l'endpoint Zen pay-as-you-go. Confirmation négative. | REFUTED (R1) |
| Préfixe CLI Go | `opencode/<id>` (document de décision, config IDE) | `opencode-go/<id>` pour l'abonnement Go. `opencode/` débite le solde Zen. Les 4 agents live utilisent le bon préfixe. | REFUTED pour la config IDE (R1) |
| Fallback Groq Kimi K2 | disponible (prompt d'exécution, `role-reviewer`) | `moonshotai/kimi-k2-instruct` retiré le 2025-10-10. Aucun Kimi chez Groq au 2026-09-03. | REFUTED (R2) |
| ModelScope « 2 000 appels/jour » | disponible | Système de crédits journaliers, environ 125 à 500 appels/jour, concurrence cible 1. | REFUTED (R2) |
| Z.ai « gratuit, illimité » | disponible | Concurrence dynamique par compte. Fonctions gratuites réservées au non commercial. | REFUTED (R2) |
| Qwen3.7 Max plafond 60 $ | 60 $ (document de décision) | 30 $ | REFUTED (R1) |

### 1.4 Règles du dépôt quantum touchées

Mise en correspondance règle → comment → action → scope. Les gardes techniques du dépôt privé (scripts CI, politiques OPA, garde runtime) ne sont pas détaillés ici : leur cartographie et les extensions à leur apporter vivent dans le miroir privé (§8). Scope ∈ {cette ADR, PR quantum, hors périmètre}.

| Règle | Source | Touchée comment | Action | Scope |
|---|---|---|---|---|
| Doctrine 1 truth-first | `CLAUDE.md` l.24 | `PAPERCLIP_LLM_MODE=sovereign` live à côté de modèles cloud = étiquette fausse ; `docs/agents/cloud-models.md` du fork déconseille le défaut permanent que ce déploiement pratique. VERIFIED. | Déclarer l'écart (D7) ; corriger l'étiquette (opérateur). | cette ADR + hors périmètre (env live) |
| Doctrine 2 Sovereign LLM uniquement | `CLAUDE.md` l.25 | « uniquement » contredit en dev ; la clause « en prod » n'est pas touchée. VERIFIED. | Exception formelle (cette ADR) ; scission runtime/outillage dev. | cette ADR + PR quantum |
| Doctrine 3 résidence EU/Algérie | `CLAUDE.md` l.26 | Code source, prompts et threads partent vers un fournisseur US ; hébergeur amont inconnu. VERIFIED. | Déclarer ce qui sort et vers qui (§3). | cette ADR + PR quantum |
| Doctrine 4 fail-closed | `CLAUDE.md` l.27 | `OPENCODE_ALLOW_ALL_MODELS=true`, `PAPERCLIP_ALLOW_CLOUD_MODELS=1`, budgets 0 = permissive-default. VERIFIED. | Contrôles §4 (allowlist 3 ids, budgets ≠ 0). | cette ADR (déclaration) + hors périmètre (application) |
| RULE-PROV-001 (Bifrost = config active du gateway) | `CLAUDE.md` l.54 | La SSOT du routing des agents dev n'est plus Bifrost mais le provider `opencode-go` intégré au CLI 1.17.7 + l'environnement de l'adapter Paperclip (`PAPERCLIP_OPENCODE_*`, composant consommateur hors dépôt UNVERIFIABLE). Nouvelle surface déclarée ici. VERIFIED. | Déclaration ; checklist pré-PR #13 à amender. | cette ADR + PR quantum |
| RULE-PROV-002 (SovereigntyGuard sur chaque egress LLM) | `CLAUDE.md` l.55 | La règle vise le runtime Go de quantum-api ; ce chemin (CLI opencode → `opencode.ai`) n'est vu par aucun contrôle d'egress du dépôt quantum. Trou de couverture, pas une violation du code. VERIFIED. | Truth Boundary §7. | cette ADR |
| RULE-PROV-003 (zéro provider cloud Active dans `store.go`/migrations) | `CLAUDE.md` l.56 | Non touchée dans la lettre. Groq et xAI nommés : le plan Bifrost/Groq heurterait la règle. VERIFIED. | Déclarer « non touché » ; Groq exclu (D4). | cette ADR |
| RULE-PROV-006 (aucune clé LLM cloud commitée) | `CLAUDE.md` l.57 | Contrainte de rédaction : aucune valeur de clé dans cette PR. VERIFIED (relu). | Respecter. | cette ADR |
| RULE-SEC-003 (aucun secret commité) | `CLAUDE.md` l.83 | Idem ; aucun nom de clé ni de clé virtuelle dans ce texte public. | Respecter. | cette ADR |
| RULE-BODY-003 (Truth Boundary) | `CLAUDE.md` l.87 | S'applique à cette PR et au miroir. | §7. | cette ADR |
| Checklist pré-PR #13 (scope SSOT du routing) | `CLAUDE.md` l.130 | La déviation modifie une cinquième source non listée (env adapter Paperclip + provider intégré CLI). VERIFIED. | Déclarer ici ; amender la checklist. | cette ADR + PR quantum |
| Règle agent souverain « vérifier `forbidden_providers` avant tout changement de routing LLM » | `CLAUDE.md` l.181 | Le changement de routing du 2026-09-02 a été fait sans cette vérification (Groq figurait au plan). Constat, VERIFIED. | Cette ADR vaut déclaration a posteriori ; toute modification ultérieure de routing repasse par cette vérification. | cette ADR |
| Allowlist SSOT (`allowlist-only`, `no-cloud-egress`) | `docs/governance/llm-model-allowlist.yml` | `opencode-go/*` absent ⇒ implicitement bloqué ; hôte `opencode.ai` hors `allowed_hosts`. Blocklist « DeepSeek cloud API — CN egress » : lettre non touchée (hôte différent), esprit touché par `deepseek-v4-pro` servi en cloud, upstream inconnu. VERIFIED. | Bloc `deviations:` non consommé, PR quantum ; aucune entrée dans `allowlist:`. | PR quantum |
| ADR-GOV-015 §2 « Zero frontier runtime … only » | `docs/adr/ADR-GOV-015` l.43 | Doctrine dev active contredite. VERIFIED. | Amendement ou renvoi, PR quantum. | PR quantum |
| ADR-GOV-015 §3.1 posture full-auto | `docs/adr/ADR-GOV-015` l.55 ; `docs/SSOT/GOVERNANCE_ACTIVE_POLICY.md` l.30-32 | « No human review is required to merge in dev/test » ; `required_approving_review_count = 0` ; auto-merge natif sur PR bot. VERIFIED. Conditionne D6. | Aucun état « maker-checker humain » n'est revendiqué (D6). | cette ADR |
| ADR-GOV-015 §3.4 (« Frontier model leak in PR body ») | `docs/adr/ADR-GOV-015` l.80 | Tension avec la déclaration du modèle réel dans les corps de PR (D7). VERIFIED texte. | Tranché côté quantum (§8.9). | PR quantum |
| ADR-GOV-015 §5 (jalon GO production) | `docs/adr/ADR-GOV-015` l.97-100 | Jalon de fin naturel (D9). VERIFIED. | Expiry (en-tête, D9). | cette ADR |
| ADR-GOV-026 (gates jamais dégradés) | `docs/adr/ADR-GOV-026` l.14-17 | La déviation doit rester hors du code et de la config quantum. VERIFIED. | Contrainte énoncée (D4). | cette ADR |
| ADR-ARCH-003 (drivers, table rôles → GPU souverain) | `docs/adr/ADR-ARCH-003` | Driver « pas d'anthropic », table de routage devenus faux pour le dev. VERIFIED. | Bandeau, PR quantum. | PR quantum |
| ADR-SEC-010 + registre ICT | `docs/adr/ADR-SEC-010-*` ; `docs/compliance/ict-register.yaml` | « cloud egress disabled and EU data residency asserted » fausse. VERIFIED. | Entrées tiers ICT, PR quantum. | PR quantum |
| ADR-0042B META / GREY | `docs/architecture/adrs/ADR-0042B-*` l.72-73 | Seul crochet doctrinal tolérant un outillage externe ; GREY exige « separate human-approved ADR ». VERIFIED. | Classification à la signature (§9). | cette ADR + PR quantum |
| GOVERNANCE_ACTIVE_POLICY « no silent cloud egress » | `docs/SSOT/GOVERNANCE_ACTIVE_POLICY.md` l.19 | « silent » cesse au merge public de l'ADR signée ; `docs/adr/` est chemin sacré (`prod-gate-required` sur le miroir). VERIFIED. | Respecter la condition. | cette ADR + PR quantum |
| PR_REVIEW_RULES régime d'exception (six champs) | `docs/SSOT/PR_REVIEW_RULES.md` l.125-134 | Squelette minimal de cette ADR ; l.134 interdit qu'une exception autorise un « cloud egress bypass ». VERIFIED. | §7.1 ; contradiction ouverte (§8.6). | cette ADR + PR quantum |
| HUMAN_GATES « aucun cloud externe autorisé sans approbation explicite » | `docs/SSOT/HUMAN_GATES.md` l.38 | Condition remplie par la signature §9 pour ce périmètre ; sans signature, hors règle. VERIFIED. | §9. | cette ADR |
| ADR_STATUS_TAXONOMY | `docs/SSOT/ADR_STATUS_TAXONOMY.md` l.11-33 | Statuts autorisés, métadonnées obligatoires. VERIFIED. | En-tête conforme. | cette ADR |
| DECISION_B (cursor-agent interdit) | mémoire opérateur 2026-08-13 | Cohérent avec D4 ; l'usage humain de Cursor est un egress distinct non couvert. VERIFIED (mémoire). | D4. | cette ADR |
| Workflows CI sur runner auto-hébergé (20) | `.github/workflows/*` | Non touchés ; le GPU souverain reste utilisé par la CI, pas par les agents. VERIFIED (FACTS). | Inventaire, PR quantum. | hors périmètre |

## 2. Décision

Les décisions D1 à D10 décrivent la déviation telle qu'elle doit être si l'opérateur la signe. Là où le live diffère encore, l'écart est dit.

### D1. Périmètre : développement uniquement

- Une seule company Paperclip : « Core Banking Factory » (celle qui porte le plan QUA et les quatre agents Q-Gov, Q-Impl, Q-Web, QA-Tests ; identifiant non reproduit ici, dépôt public). La company « Beyn » est hors périmètre : aucun agent cloud n'y est autorisé.
- Le flag cloud `PAPERCLIP_ALLOW_CLOUD_MODELS` est global à l'instance Paperclip (lu à chaque requête, sans scope company ; VERIFIED R3). La limitation à une company est une règle de conduite, pas un verrou logiciel.
- Un seul dépôt : quantum, branches de développement.
- Aucune donnée de production, de client, de tenant bancaire réel dans le répertoire de travail, les issues, les commentaires ou les documents accessibles aux agents. Sont des données de production au sens de cette ADR : tout export ou dump de base de production ou de pré-production, tout fichier `.env` ou secret, tout log applicatif, toute fixture ou pièce jointe dérivée de données réelles, tout identifiant de client ou de tenant, tout document de conformité signé.
- Aucun secret dans les prompts, les issues ou les commentaires.
- Le déploiement Paperclip de production, le runtime Quantum et le CBS ne sont pas concernés. Leur doctrine souveraine reste entière.

Étiquette : le périmètre est une décision (PROPOSED jusqu'à signature). Le checkout et les issues n'ont pas été audités au titre de la définition ci-dessus (UNVERIFIABLE) : cet audit est une précondition de la signature (§7.1).

### D2. Fournisseur LIVE : OpenCode Go

| Agent | Rôle | Modèle exact | Plafond Go du modèle | Rétention / entraînement (tableau officiel Go) | Étiquette |
|---|---|---|---|---|---|
| Q-Gov | planner | `opencode-go/deepseek-v4-pro` | 15 $/mois | « Not used / 0 days* ». L'astérisque renvoie à un accord ZDR mensuel « valid through August 31, 2026 » sur une page datée du 3 septembre 2026. | Modèle VERIFIED ; ZDR en vigueur UNVERIFIABLE à la date de rédaction |
| Q-Impl | engineer | `opencode-go/kimi-k2.7-code` | 60 $/mois | « Not used / 0 days » | VERIFIED |
| Q-Web | engineer | `opencode-go/kimi-k2.7-code` | 60 $/mois | « Not used / 0 days » | VERIFIED |
| QA-Tests | qa | `opencode-go/glm-5.3-flash` | 15 $/mois | « Not used / 0 days » | VERIFIED |
| (tous) | small model | `opencode-go/glm-5.3-flash` | idem | idem | VERIFIED (variable d'environnement) |

Les plafonds par modèle ne s'additionnent pas : les quatre agents partagent une seule souscription Go (une seule variable de clé workspace côté conteneur, VERIFIED FACTS) et donc ses plafonds globaux, 60 $/mois, 30 $/semaine et 12 $ par fenêtre de 5 heures, pour la flotte entière ; le plafond par modèle s'applique à la somme des agents sur ce modèle. Promotion temporaire en cours sur `glm-5.3-flash` (« 2× usage limits for a limited time », non chiffrée en dollars dans la doc ; VERIFIED R1).

Faits sur le fournisseur (R1, sources officielles datées du 2026-09-03) :

- Entité : Anomaly, San Francisco (VERIFIED, politique de confidentialité). La politique de confidentialité lue (effective 2026-03-06) ne mentionne ni RGPD ni mécanisme de transfert UE→US ; cadre = lois d'États américains (VERIFIED : absence dans ce document). Existence d'une clause dans les Terms of Service ou d'un DPA / SCC : UNVERIFIABLE (Terms of Service non analysés).
- Abonnement : 10 $/mois par workspace, un abonné par workspace. Plafonds : 60 $/mois, 30 $/semaine, 12 $ par fenêtre de 5 heures (nature glissante ou fixe non précisée par la doc). VERIFIED. La doc prévient que ces limites peuvent changer.
- Hébergement : « All our models are hosted in the US » figure sur la page Zen. `deepseek-v4-pro` et `kimi-k2.7-code` sont dans la liste Zen. `glm-5.3-flash` n'y figure pas : pour lui, l'affirmation « US » est UNVERIFIABLE au sens littéral.
- Hébergeur amont par modèle (qui fait tourner le poids, dans quel pays) : non publié. UNVERIFIABLE. La chaîne de sous-traitance ICT au-delà d'Anomaly est inconnue.
- Ce que fait le proxy Anomaly lui-même des prompts : politique « Not stored » ; historique GitHub d'un stockage limité aux modèles gratuits ; demande de clarification fermée sans réponse humaine. UNVERIFIABLE de l'extérieur.
- Endpoints : `https://opencode.ai/zen/go/v1/{chat/completions, responses, messages, models}`. Trois familles d'API selon le modèle. VERIFIED.
- Dépassement des plafonds : l'option « Use balance » (bascule vers le solde Zen) est opt-in, désactivée par défaut. Son état réel sur le workspace agents n'est visible que dans la console de l'opérateur : UNVERIFIABLE ici. Un repli automatique vers des modèles « Free » n'est pas décrit par la doc officielle ; s'il existait, il enverrait le code vers des modèles à entraînement possible (D4, D6, D10.6).
- Tarif horaire : DeepSeek V4 Pro est facturé ×2 en heures « peak » (01:00 à 04:00 et 06:00 à 10:00 UTC, lundi à vendredi). Q-Gov consomme son plafond deux fois plus vite le matin en semaine. VERIFIED.

Dépense constatée depuis le 2026-09-02 (somme des coûts déclarés par le CLI opencode, arrondis au cent par run, mois UTC) : Q-Gov 589 cents, Q-Impl 946 cents, Q-Web 236 cents, QA-Tests 25 cents. VERIFIED en base ; exactitude économique UNVERIFIABLE (grille tarifaire embarquée dans le CLI, pas dans Paperclip).

### D3. Fournisseurs PRÉVUS par le plan : déclarés, non câblés, non couverts par la signature

Aucun de ces trois fournisseurs n'existe aujourd'hui, ni dans Bifrost ni dans l'environnement Paperclip (VERIFIED). Cette ADR les déclare parce que le plan les nomme. Elle ne les active pas, et la signature §9 ne peut pas les activer : l'activation de chacun exige un amendement daté de cette ADR (nouvelle révision, nouvelle signature) après levée du blocage contractuel identifié (voir les lignes D3 du tableau §9).

| Fournisseur | Endpoint prévu | Pays / droit | Rétention des prompts | Entraînement sur les prompts | Blocage identifié | Étiquette |
|---|---|---|---|---|---|---|
| NVIDIA Build | `integrate.api.nvidia.com` | États-Unis. NVIDIA Corporation, Santa Clara. Droit du Delaware, arbitrage JAMS obligatoire. Transferts vers les US sous SCC et DPF. | « Not store … at the end of each API Service session » sauf journalisation sécurité/fraude. Durée des logs non publiée. | Clause explicite : User Content et Generated Content collectés « to improve NVIDIA products and services, including AI models » (Trial ToS §3.3(iv)). À traiter comme entraînement possible. | Tier gratuit régi par le Trial ToS : « internal testing and evaluation purposes, not in production » (§1.4). Interdiction d'envoyer des données confidentielles (§2.6(a)). Limite « 40 RPM » non publiée. | Juridiction et entraînement VERIFIED ; rétention des logs et RPM UNVERIFIABLE |
| ModelScope | `api-inference.modelscope.cn` | Chine continentale. Contractant à Shanghai, tribunal de Hangzhou. Données stockées en Chine continentale. Service déclaré destiné aux utilisateurs de Chine continentale. | Aucune clause dédiée à l'API. Le contenu des conversations est classé « données de log », conservé « pour la durée nécessaire ». | Aucune clause. Licence mondiale, irrévocable, sous-licenciable sur tout contenu utilisateur (§3.2.1). | Produit déclaré non commercial, sans SLA. Un compte par utilisateur. Vérification d'identité Alibaba Cloud obligatoire. Quota réel : environ 125 à 500 appels/jour, concurrence 1. | Juridiction et non commercial VERIFIED ; rétention et entraînement UNVERIFIABLE ; quota du plan REFUTED |
| Z.ai / Zhipu (endpoint chinois) | `open.bigmodel.cn` | Chine continentale. Contractant à Pékin, droit de la RPC. Données stockées en Chine continentale. L'entrée réseau passe par un accélérateur Alibaba (edge Francfort), ce qui n'est pas le lieu de traitement. | « Stockage minimal nécessaire ». Durée non publiée. | Pas de clause de non-entraînement côté endpoint chinois. Usage anonymisé autorisé pour améliorer la plateforme. | Fonctions non payantes réservées à un usage « non commercial, de recherche et d'apprentissage personnels » (§七.2). Concurrence « 1 » non publiée par l'éditeur. | Juridiction et restriction non commerciale VERIFIED ; rétention, entraînement, concurrence UNVERIFIABLE |

Note : l'endpoint international `api.z.ai` relève d'une entité de Singapour dont le DPA promet de ne pas stocker le contenu API (VERIFIED). Le plan ne le vise pas. Le remplacer à l'endpoint chinois serait une décision distincte.

### D4. EXCLUS du périmètre

| Exclu | Motif | Étiquette |
|---|---|---|
| Groq (`api.groq.com`) | Interdit nommément dans le dépôt quantum : RULE-PROV-003, gates CI de souveraineté et d'allowlist, ADR-SEC-010, tests ICT. Ne peut entrer qu'après amendement de la règle dans quantum, par une décision séparée. De plus, le modèle Kimi visé par le plan n'existe plus chez Groq, et le plan Free plafonne à 8 000 tokens/minute sur les modèles texte généralistes listés (gpt-oss, qwen3.x-27b ; VERIFIED R2), incompatible avec des prompts d'agents de 40 à 80 K tokens. | VERIFIED |
| xAI / `opencode-go/grok-4.6` | Rétention 30 jours dans le tableau officiel Go. `xai` interdit nommément dans quantum (RULE-PROV-003). | VERIFIED |
| `opencode-go/gpt-5.6-luna` | Rétention 30 jours (« abuse monitoring logs »). Modèle OpenAI, hors doctrine. | VERIFIED |
| Modèles « Muse Spark Contributor » | Tableau officiel : entraînement « Yes / Not ZDR ». | VERIFIED |
| Tout modèle Zen « Free » (`opencode/*-free`, `big-pickle`, etc.) | « collected data may be used to improve the model ». L'exclusion n'est opposable que si le comportement hors plafond est constaté égal à « blocage » dans la console (D6, D10.6). | VERIFIED |
| Tout autre modèle du catalogue Go ou Zen | Fail-closed : seuls les trois modèles de D2 sont couverts. Le catalogue ouvert (28 modèles) est un état à corriger, pas un droit. | Décision (PROPOSED jusqu'à signature) |
| Cursor | Aucun agent Paperclip n'est piloté par Cursor (DECISION_B du 2026-08-13 maintenue : `cursor-agent` interdit, inférence routée vers l'infrastructure Cursor). L'usage humain de Cursor sur le checkout quantum constitue un egress distinct vers l'infrastructure Cursor, NON couvert par cette ADR ; il est soit déclaré dans une ligne séparée de D2 et §3 (fournisseur, modèles, mode privacy — état UNVERIFIABLE à la rédaction), soit interdit sur ce dépôt jusqu'à déclaration. L'opérateur tranche à la signature (§9). | VERIFIED (mémoire opérateur) ; état du poste UNVERIFIABLE |
| Tout usage sur données de production, de client, de tenant bancaire | Périmètre D1 (définition incluse). | Décision |
| Le runtime Quantum, le CBS, `store.go`, les migrations, les gates CI | ADR-GOV-026 : les gates de souveraineté, OPA, anti-fake-test et RLS ne sont jamais dégradés. La déviation vit hors du code et de la config quantum. Toute fuite d'un modèle cloud dans ce code produit une CI rouge légitime. | VERIFIED (texte) |

### D5. Bifrost comme point de sortie unique : cible, pas état

- Cible : tout appel modèle sort par Bifrost, qui porte UNIQUEMENT le fournisseur de D2 (OpenCode Go) et, pour chacun, après amendement daté et nouvelle signature, ceux de D3 ; aucune chaîne de repli vers un fournisseur non signé ; Groq et tout provider de D4 sont exclus de la cible comme de l'état. Les modèles virtuels `role-*` du plan n'existent pas et ne sont pas décidés ici.
- État actuel : egress direct conteneur → `opencode.ai`. Bifrost n'a aucun provider cloud. Bifrost ne voit aucun appel des agents. VERIFIED.
- Conséquence : aucun contrôle d'egress du dépôt quantum ne s'applique à ce trafic. Ce n'est pas une autorisation. C'est un trou de couverture déclaré.
- Contrainte technique connue pour la cible : le provider Bifrost doit viser `https://opencode.ai/zen/go/v1` et gérer trois familles d'API (`chat/completions`, `responses`, `messages`). VERIFIED (R1).
- Échéance de mise en conformité avec la cible : à fixer par l'opérateur à la signature. Proposition : au plus tard la date de réévaluation (D9). Tant que la cible n'est pas atteinte, l'état « egress direct » reste déclaré ici et dans le runbook.

### D6. Budgets et revue des PR

- Plafond mensuel par agent obligatoire, différent de zéro. Dans Paperclip, 0 = aucune limite (VERIFIED). L'enforcement (alerte à 80 %, pause et annulation des runs à 100 %) n'existe que si une ligne `budget_policies` existe. `PATCH /api/agents/:id` avec `budgetMonthlyCents` ne crée pas cette ligne. Il faut `PATCH /api/agents/:id/budgets`. VERIFIED (R3).
- Valeurs de référence du plan : coders 9 $ chacun (Q-Impl, Q-Web), planner 8 $, QA 8 $ (prompt d'exécution, tableau de routage ; document de décision « Version du 3 septembre 2026 », §« Répartition des 60 $ »). Le plan affecte Q-Gov au rôle coder (9 $) alors que Q-Gov est planner en live sur `deepseek-v4-pro` (plafond Go 15 $). L'opérateur tranche la valeur à la signature.
- Contrainte de flotte (PROPOSED) : la somme des budgets Paperclip reste ≤ 60 $/mois et, tant que le comportement hors plafond n'est pas constaté égal à « blocage » dans la console OpenCode, le budget Paperclip de chaque agent est fixé strictement sous le plafond Go de son modèle (budget ≤ 80 % du plafond Go, hard stop à 100 % du budget Paperclip). Le rythme de la flotte doit rester sous 12 $ par fenêtre de 5 heures ; Paperclip n'enforce pas cette fenêtre (mois UTC seulement, VERIFIED R3) : contrainte à surveiller sur la console.
- Le coût mesuré est celui déclaré par le CLI opencode (`part.cost`, grille embarquée, exactitude UNVERIFIABLE), arrondi au cent par run. Paperclip n'a pas de grille tarifaire. VERIFIED.
- Reviewer : le plan exige un reviewer sur un modèle différent des coders. Aucun agent reviewer n'existe en live (4 agents : planner, engineer ×2, qa). VERIFIED.
- Revue des PR produites par ces agents : la posture active du dépôt quantum est le full-auto dev (`docs/SSOT/GOVERNANCE_ACTIVE_POLICY.md` l.30-32, ADR-GOV-015 §3.1 : `required_approving_review_count = 0`, « No human review is required to merge in dev/test », auto-merge natif sur PR bot après checks requis). Aucune revue humaine systématique n'est en place ni exigée en dev ; seuls les chemins sacrés restent opérateur-gated via `prod-gate-required` (ADR-GOV-015 §3.3). VERIFIED (SSOT lus ; env live `PAPERCLIP_AUTONOMOUS_DELIVERY=1`, `PAPERCLIP_DELIVERY_LANE=dev`). Si l'opérateur veut une revue humaine des PR issues de modèles cloud, c'est un contrôle NOUVEAU, PROPOSED : label `human-review-required` ou `risk:red` posé par le wrapper de PR, à câbler côté quantum (§8) — pas un état existant.

### D7. Étiquetage truth-first

- `PAPERCLIP_LLM_MODE` ne doit plus valoir `sovereign` sur ce déploiement. La variable est inerte dans le code Paperclip (VERIFIED, 0 occurrence), mais une variable de mode qui contredit la réalité est une violation truth-first de même sévérité qu'une violation fonctionnelle.
- Le bloc provider `openrouter` mort doit être retiré de l'environnement. Il déclare des modèles `claude-*`, `gpt-5*`, `gemini-*`, `grok-*` que la blocklist quantum classe HARD_BLOCK.
- L'interface Paperclip affiche un badge statique « Sovereign models only » (`ui/src/pages/Agents.tsx`), inconditionnel, et filtre les modèles côté client sans lire le flag. VERIFIED (R3). Le bandeau doit refléter le mode cloud quand `PAPERCLIP_ALLOW_CLOUD_MODELS=1`. Travail à faire dans le fork.
- Le prompt par défaut envoyé aux agents contient « Use only sovereign agent models ». Il est envoyé à un modèle cloud. VERIFIED (R3). Incohérence à corriger ou à documenter dans le template.
- `docs/agents/cloud-models.md` du fork affirme qu'un agent cloud continue de fonctionner flag éteint. Le code dit le contraire : le garde tourne à chaque heartbeat. REFUTED (R3). Un addendum corrige sans effacer le conseil d'origine.
- Les corps de PR produits par ces agents doivent nommer le provider et le modèle réels (`opencode-go/kimi-k2.7-code`, etc.) : le template de body agent de CLAUDE.md exige déjà le champ **Agent** (provider réel). Tension déclarée avec ADR-GOV-015 §3.4 (« Frontier model leak in PR body ») : savoir si cette déclaration tombe sous §3.4 ou sous ses exclusions R2-FIX est tranché côté quantum (§8.9), pas ici.

### D8. Hygiène des secrets

- Règle : aucune clé du serveur ne doit être copiée sur un poste de travail. Constat : les clés d'accès du déploiement (clé board, clé virtuelle de passerelle) ont été renouvelées le 2026-09-03 — VERIFIED (FACTS ; noms non reproduits ; motif détaillé dans le miroir privé).
- Règle (PROPOSED) : la clé OpenCode Go du poste de travail (workspace IDE) et celle des agents (workspace agents) restent distinctes ; la clé IDE ne va pas sur le serveur. État live de cette séparation : UNVERIFIABLE depuis le fact pack (une seule variable de clé côté conteneur), à confirmer dans la console OpenCode à la signature.
- Le CLI opencode hérite de tout l'environnement du processus serveur sauf les variables `PAPERCLIP_*` : clés OpenCode, clé virtuelle Bifrost, jetons GitHub, secret d'authentification (VERIFIED, R3). Leur transmission au fournisseur dépend d'un tool-call lisant l'environnement (UNVERIFIABLE). Réduire l'environnement hérité par le CLI au strict nécessaire est un contrôle à faire (§4).
- Aucun secret, aucun nom de clé, aucune adresse interne dans ce dépôt public.

### D9. Durée et réévaluation

- La déviation prend fin à la PREMIÈRE des dates suivantes : (1) le critère mesurable « Quantum prêt » fixé à la signature est atteint (l'opérateur remet les agents souverains, D10) ; (2) ouverture d'une ADR `ADR-GOV-016` ou ultérieure au sens d'ADR-GOV-015 §5 (« GO production migration », `Status: PRODUCTION-GO-CANDIDATE`) ; (3) 2026-12-02 sans nouvelle signature datée ; (4) l'une des conditions D10.1 à D10.4 ou D10.6. Aucun agent cloud ne survit à ces échéances.
- « Quantum prêt » n'a pas de définition mesurable aujourd'hui. L'opérateur en fixe une à la signature. Forme attendue : critères vérifiables (par exemple : jalons de gates, couverture, état de la migration production), pas une impression. Cette rédaction n'en invente aucun.
- Précédent : ADR-0042B tolère un outillage externe en périmètre META (« declared non-sensitive scope and audit caveat ») ou GREY (« separate human-approved ADR »), avec un précédent daté « sunset 2026-12-31 ». Le code source Quantum privé est-il « non-sensitive » ? C'est à l'opérateur de le dire à la signature. Sinon le périmètre est GREY : la signature §9 vaut décision de déviation par l'opérateur (approbation opérateur du risque), et rien d'autre ; elle ne vaut ni approbation de conformité (DORA, RGPD), ni levée des gates quantum, ni satisfaction automatique d'ADR-0042B dans le dépôt quantum — cette qualification est portée dans le miroir quantum (§8.5), par revue humaine distincte selon les règles de ce dépôt.
- À chaque réévaluation : relire les plafonds Go (la doc annonce qu'ils peuvent changer), vérifier l'accord ZDR DeepSeek du mois, vérifier l'état « Use balance » dans la console, relire ce tableau de conséquences.

### D10. Conditions et procédure de retour au souverain

Conditions de retour immédiat, sans attendre le jalon :

1. Toute donnée de production, de client ou de tenant bancaire (définition D1) entre dans le périmètre des agents.
2. Un secret transite vers un fournisseur (constaté ou fortement soupçonné).
3. Le fournisseur change ses conditions de rétention ou d'entraînement pour un modèle de D2.
4. L'accord ZDR DeepSeek n'est pas renouvelé et `deepseek-v4-pro` reste configuré.
5. La date de réévaluation est dépassée sans nouvelle signature.
6. Un plafond Go (5 h, semaine, mois, ou plafond par modèle) est atteint pour un agent alors que le comportement hors plafond n'a pas été constaté égal à « blocage » dans la console : pause immédiate de l'agent concerné.

Procédure : voir le runbook `docs/deploy/dev-cloud-opencode-go.md`, section « Procédure de retour au souverain ». Résumé : pause des agents ; `PATCH` du modèle vers `bifrost/qwen3-coder-30b-sovereign` ; réécriture de l'objet `adapterConfig.env` de chaque agent (retrait de `PAPERCLIP_OPENCODE_SMALL_MODEL`, `OPENCODE_ALLOW_ALL_MODELS=false`) ; retrait de `PAPERCLIP_ALLOW_CLOUD_MODELS`, de `PAPERCLIP_OPENCODE_SMALL_MODEL` (small model cloud) et du bloc provider `openrouter` à la source de l'environnement ; recréation du conteneur (pas un simple redémarrage) ; vérification du catalogue ; reprise ; vérification des heartbeats et du retour des requêtes sur Bifrost. Le GPU souverain et Bifrost sont en ligne (VERIFIED le 2026-09-03), donc le retour ne dépend d'aucune remise en service matérielle.

## 3. Ce qui sort et vers qui

Base : lecture du code du fork (R3) et état live (FACTS). Destination pour toutes les lignes : le fournisseur du modèle configuré, aujourd'hui OpenCode Go (Anomaly, États-Unis), hébergeur amont inconnu.

| Classe de donnée | Sort ? | Canal | Étiquette |
|---|---|---|---|
| Bundle d'instructions de l'agent (fichier d'entrée complet) | Oui, à chaque heartbeat | stdin de `opencode run` | VERIFIED (R3) |
| Identifiant, titre, statut, priorité de l'issue | Oui | stdin (wake prompt) | VERIFIED (R3) |
| Corps intégral des 8 derniers commentaires (≤ 12 000 caractères) | Oui | stdin (wake prompt) | VERIFIED (R3) |
| Résumés de continuation, résumés d'issues enfants, note de handoff de session | Oui | stdin | VERIFIED (R3) |
| Template de heartbeat, dont le contrat de souveraineté | Oui | stdin | VERIFIED (R3) |
| Description d'issue, thread complet, inbox, documents et pièces accessibles à l'agent | Oui, à l'initiative de l'agent | tool-calls HTTP vers l'API Paperclip avec le JWT de run, puis contexte du modèle | VERIFIED (mécanisme) ; périmètre exact UNVERIFIABLE |
| Code source du dépôt quantum (racine et `apps/web`) | Oui, tout fichier lu, écrit ou exécuté par l'agent | tool-calls du CLI dans le répertoire de travail ; aucune restriction d'outils ; `dangerouslySkipPermissions` vrai par défaut | VERIFIED (cwd, permissions) ; liste exacte des outils du binaire UNVERIFIABLE |
| Fichiers hors du répertoire de travail lisibles par l'utilisateur du conteneur | Oui, à l'initiative de l'agent | tool-calls FS (`permission.external_directory: allow`, `dangerouslySkipPermissions`) | VERIFIED (R3) |
| Services réseau joignables depuis le conteneur (le conteneur n'est pas isolé du réseau de l'hôte : passerelle locale, base embarquée, autres services locaux) | Oui, à l'initiative de l'agent | outil shell du CLI | VERIFIED (FACTS : réseau de l'hôte) ; inventaire des services UNVERIFIABLE |
| Credentials git du checkout (`.git/config`, credential store, fichiers de jetons) | Si présents, oui | tool-calls FS | UNVERIFIABLE (non audité) |
| Trafic propre du CLI opencode vers `opencode.ai` (authentification, éventuel partage ou synchronisation de session) | Probable | binaire opencode | UNVERIFIABLE |
| Variables d'environnement du serveur hors `PAPERCLIP_*` (clés OpenCode, clé virtuelle Bifrost, jetons GitHub, secret d'authentification) | Présentes dans l'environnement du CLI ; transmission au fournisseur seulement si un tool-call lit l'environnement | héritage `process.env` | VERIFIED (héritage) ; fuite effective UNVERIFIABLE |
| JWT de run court, payload de réveil en JSON, identifiants d'agent, de company, de tâche | Présents dans l'environnement du run | env explicite | VERIFIED (R3) |
| Données de production, de client, de tenant bancaire | Non, par périmètre D1 | (aucun) | Décision ; absence effective UNVERIFIABLE (non auditée) |
| Métadonnées d'usage (tokens, coût déclaré) | Flux entrant, stocké en base | stdout du CLI | VERIFIED (R3) |

## 4. Contrôles compensatoires

### 4.1 État constaté (pas des verrous)

| Contrôle | État | Responsable | Base |
|---|---|---|---|
| Modèles des 4 agents = trois ids de D2 | État constaté, non verrouillé : flag ON, `PATCH /api/agents/:id` accepte tout id et les profils de modèle sont appliqués sans filtre ; seul l'override de modèle d'une issue est filtré à l'écriture (validateur partagé). À verrouiller côté config opencode (4.2). | opérateur | SQL live ; R3 |
| Périmètre d'egress : un seul provider de modèle configuré | État ; `opencode/*` (Zen) est aussi listé par le CLI, et l'egress des outils shell/web du CLI n'est pas borné (UNVERIFIABLE) | opérateur | FACTS |
| Le flag cloud est lu à chaque requête : une recréation du conteneur sans la variable rétablit les gardes immédiatement | Propriété du code | fork | R3 (BACKEND-WIRED : non exercée en live) |
| Clés d'accès du déploiement renouvelées | Fait (2026-09-03) | opérateur | FACTS |

### 4.2 À faire

| Contrôle | État | Responsable | Base |
|---|---|---|---|
| Egress déclaré publiquement | À faire — devient effectif au merge de cette ADR signée (commit SHA à reporter en §9). Avant cela, l'egress reste non déclaré publiquement. | opérateur | cette ADR |
| Audit du checkout et des issues accessibles aux agents : données de production au sens de D1, dumps, `.env`, credentials git, fixtures clients (gitleaks sur l'arbre de travail, revue des pièces jointes) | À faire — précondition de signature (§7.1) | opérateur | cette ADR |
| Budgets ≠ 0 via `PATCH /api/agents/:id/budgets` pour les 4 agents, valeurs D6 | À faire | opérateur | R3 |
| Allowlist de modèles côté config opencode (les trois ids de D2) et `OPENCODE_ALLOW_ALL_MODELS` retiré (sémantique exacte de la variable côté CLI UNVERIFIABLE, à confirmer dans la doc opencode) | À faire | opérateur | FACTS ; R3 |
| Filtrage réseau sortant du conteneur (allowlist : `opencode.ai`, `github.com`, passerelle locale) | À faire — inexistant aujourd'hui (UNVERIFIABLE : aucun filtrage constaté) | opérateur | cette ADR |
| Retirer le bloc provider `openrouter` de l'environnement | À faire | opérateur | FACTS |
| `PAPERCLIP_LLM_MODE` ≠ `sovereign` ; bandeau UI reflétant le mode cloud | À faire | opérateur (env) ; fork (UI) | R3 |
| Réduire l'environnement hérité par le CLI (jetons GitHub, secret d'authentification) au nécessaire | À faire | fork + opérateur | R3 |
| Vérifier dans la console OpenCode : « Use balance » désactivé sur le workspace agents ; comportement hors plafond = blocage ; séparation des clés IDE / agents | À faire (console de l'opérateur) | opérateur | R1 |
| Vérifier chaque mois l'accord ZDR DeepSeek ; sinon retirer `deepseek-v4-pro` | À faire, récurrent | opérateur | R1 |
| Faire passer l'egress par Bifrost (cible D5) | À faire, échéance à fixer | opérateur | FACTS ; R1 |
| Test du fork couvrant « flag éteint + agent déjà cloud » au runtime | À faire | fork | R3 (aucun test existant) |
| Corps de PR des agents : provider et modèle réels déclarés | À faire | opérateur (template) | R4 |
| Entrées tiers ICT dans le dépôt quantum (ADR-SEC-010) | À faire, PR séparée | opérateur | R4 |

### 4.3 Contrôles périphériques (hors du chemin d'egress cloud ; ne compensent rien pour cette déviation)

| Contrôle | État | Responsable | Base |
|---|---|---|---|
| Bifrost exige une clé virtuelle sur l'inférence ; anonyme → 401 | Fait | opérateur | FACTS (vérifié 02 et 03/09) |
| Content logging Bifrost désactivé ; rétention 30 jours | Fait | opérateur | FACTS |

## 5. Conséquences

### Positives

- L'état réel est écrit, daté, borné. Le régime « egress silencieux » cesse au merge public de l'ADR signée, pas avant.
- Le coût déclaré par le CLI opencode (`part.cost`, grille embarquée, exactitude UNVERIFIABLE) alimente `cost_events` et rend les politiques de budget Paperclip opérantes une fois posées.
- Le GPU souverain reste en ligne et disponible. Le retour au souverain ne dépend d'aucune remise en service.

### Négatives

- Le code source Quantum, les prompts et les threads d'issues quittent l'Union européenne et l'Algérie vers un fournisseur américain dont l'hébergeur amont est inconnu.
- L'assertion « cloud egress disabled and EU data residency asserted » du registre ICT quantum (ADR-SEC-010) est fausse au plus tard depuis le 2026-09-02, jusqu'à correction.
- La preuve souveraine du développement est perdue pour la durée de la déviation : aucun contrôle d'egress du dépôt quantum ne s'applique à ce trafic.
- La doctrine écrite (CLAUDE.md doctrines 2, 3 et 4, ADR-GOV-015 §2, ADR-ARCH-003, `PR_REVIEW_RULES.md` régime d'exception) est en contradiction ouverte tant que le miroir quantum n'est pas mergé.

### Risques nommés

| Risque | Nature | Étiquette |
|---|---|---|
| Juridiction US : politique de confidentialité sous droit d'États américains, sans clause RGPD dans le document lu ; hébergeur amont inconnu | Juridique, résidence | VERIFIED (R1, périmètre : politique de confidentialité) ; ToS UNVERIFIABLE |
| Juridiction CN (si D3 activé) : données en Chine continentale, tribunaux chinois, licence large sur le contenu | Juridique, résidence | VERIFIED (R2) |
| DORA tiers ICT : nouveau prestataire ICT non enregistré, chaîne de sous-traitance inconnue (Art. 28 à 30 selon ADR-SEC-010) | Conformité | VERIFIED (texte ADR-SEC-010) ; qualification réglementaire hors de cette rédaction |
| ZDR DeepSeek non attesté après le 31 août 2026 | Rétention | UNVERIFIABLE à la date de rédaction |
| Dépendance aux plafonds Go (60 $/mois, 30 $/semaine, 12 $/5 h, 15 $ par modèle premium), partagés par les quatre agents ; la doc annonce des changements possibles | Disponibilité | VERIFIED |
| Repli hors plafond vers un modèle « Free » à entraînement possible | Rétention, entraînement | UNVERIFIABLE (comportement non décrit officiellement) ; couvert par D10.6 |
| Secrets dans l'environnement hérité par le CLI | Sécurité | VERIFIED (héritage) ; fuite UNVERIFIABLE |
| Catalogue ouvert : `grok-4.6`, `gpt-5.6-luna` sélectionnables par erreur ou par un agent | Fail-open | VERIFIED |
| Budget 0 : aucune limite de dépense côté Paperclip tant que les politiques ne sont pas posées | Coût | VERIFIED |
| Egress humain via Cursor sur le même checkout, non déclaré | Résidence | UNVERIFIABLE (état du poste) ; tranché à la signature (D4) |
| Contradiction ouverte avec `docs/SSOT/PR_REVIEW_RULES.md` l.134 (« An exception cannot authorize … cloud egress bypass ») | Gouvernance | VERIFIED ; à trancher par amendement du SSOT quantum (RULE-ADR-006) ou à assumer comme contradiction déclarée |

## 6. Alternatives rejetées

| Alternative | Pourquoi elle n'est pas retenue | Qui décide |
|---|---|---|
| Revenir au souverain maintenant | Le GPU souverain est en ligne et inactif : l'alternative est techniquement immédiate. L'opérateur l'écarte pour la période de développement (décision citée en 1.1 ; le document de décision « Version du 3 septembre 2026 » vise la sortie du GPU souverain et un « Budget cible : 40 $/mois tout compris », l.7). Cette rédaction ne juge pas ce choix. Elle le date. | opérateur |
| Bifrost d'abord, ADR ensuite | Reporter la déclaration à la mise en place des providers Bifrost prolonge un état non déclaré. La condition « à visage découvert » impose de déclarer l'état actuel, egress direct compris, puis de converger vers la cible D5. | opérateur |
| Cloud sans ADR | C'est l'état constaté du 2026-09-02 au 2026-09-03. Il viole « no silent cloud egress » (`docs/SSOT/GOVERNANCE_ACTIVE_POLICY.md` l.19) et « aucun cloud externe autorisé sans approbation explicite » (`docs/SSOT/HUMAN_GATES.md` l.38). La signature §9 est la décision explicite de l'opérateur qui lève cette seconde condition pour le périmètre D1-D2 ; la première cesse au merge public. Rejeté. | doctrine |
| Inscrire les modèles cloud dans l'allowlist quantum | Le gate CI de l'allowlist refuse tout provider hors liste locale (exit 1). L'allowlist reste souveraine. La déviation vit hors de l'allowlist, dans cette ADR. | doctrine |

## 7. Truth Boundary

| Élément | Statut | Source |
|---|---|---|
| 20 agents en base, 4 `idle`, 16 `terminated` le 2026-09-02 | VERIFIED | SQL live 2026-09-03 |
| Révocation effective en base des clés des 16 agents terminés | UNVERIFIABLE (route vérifiée dans le code seulement) | R3 |
| Modèles exacts des 4 agents et small model | VERIFIED | SQL live ; env du conteneur |
| `budget_monthly_cents = 0` ×4 et signification « aucune limite » | VERIFIED | SQL live ; R3 (`budgets.ts`, UI) |
| Egress direct conteneur → `opencode.ai`, hors Bifrost ; 0 requête Bifrost depuis 10:30 UTC | VERIFIED par inférence ; capture du flux non réalisée | FACTS |
| Bifrost sans provider cloud, auth par clé virtuelle, content logging off | VERIFIED | FACTS |
| GPU souverain en ligne, 0 % d'utilisation, environ 63 % de VRAM occupée | VERIFIED | nvidia-smi 2026-09-03 14:05 UTC |
| Composition du prompt, héritage de l'environnement, absence de restriction d'outils | VERIFIED | R3 (`execute.ts`, `server-utils.ts`, `runtime-config.ts`) |
| Enforcement budget via `budget_policies` uniquement ; route `PATCH /api/agents/:id/budgets` | BACKEND-WIRED (code présent, aucune politique live pour les 4 agents) | R3 (`budgets.ts`, `routes/costs.ts`) |
| Flag `PAPERCLIP_ALLOW_CLOUD_MODELS` lu à chaque requête ; valeur littérale `1` | BACKEND-WIRED | R3 (`sovereign-models.ts`) |
| Garde souverain lexical (mot `sovereign`/`souverain`), jamais réseau | VERIFIED | R3 |
| `resume` refuse un agent `terminated` (409) | VERIFIED | `server/src/services/agents.ts` l.510 |
| Rollback de configuration d'agent via révisions | BACKEND-WIRED (route présente ; révisions live non inspectées) | R3 (`routes/agents.ts`) |
| Plafonds Go, prix par modèle, rétention par modèle | VERIFIED | R1 (docs officielles datées 2026-09-03) |
| Hébergement US de `glm-5.3-flash` | UNVERIFIABLE | R1 (absent de la liste Zen) |
| Hébergeur amont et pays de traitement par modèle | UNVERIFIABLE | R1 |
| ZDR DeepSeek en vigueur en septembre 2026 | UNVERIFIABLE | R1 |
| Stockage des prompts par le proxy Anomaly | UNVERIFIABLE | R1 |
| État de « Use balance » et comportement hors plafond | UNVERIFIABLE (console opérateur) | R1 |
| Terms of Service OpenCode (DPA, SCC, for) | UNVERIFIABLE (non analysés) | R1 §6 |
| Conditions NVIDIA, ModelScope, Zhipu (juridiction, restrictions d'usage) | VERIFIED | R2 (sources primaires) |
| Rétention des logs NVIDIA, rétention ModelScope et Zhipu, quotas gratuits chiffrés | UNVERIFIABLE | R2 |
| Sémantique de `OPENCODE_ALLOW_ALL_MODELS` côté CLI | UNVERIFIABLE | R3 (non lue par Paperclip) |
| Composant qui consomme `PAPERCLIP_OPENCODE_PROVIDERS` et `PAPERCLIP_OPENCODE_SMALL_MODEL` (hors dépôt) | UNVERIFIABLE | R3 (0 occurrence) |
| Mode d'injection des secrets dans le conteneur et mécanisme de lancement effectif | UNVERIFIABLE | FACTS (noms de variables seulement) |
| Absence de données de production (définition D1) dans le checkout et les issues | UNVERIFIABLE (non audité) | cette rédaction |
| Transmission effective de secrets au fournisseur | UNVERIFIABLE | R3 |
| Séparation des clés OpenCode IDE / agents | UNVERIFIABLE | FACTS |
| État des fonctions IA / privacy de Cursor sur le poste opérateur | UNVERIFIABLE | cette rédaction |
| Date exacte du passage des agents Q-* aux modèles cloud | UNVERIFIABLE (borne : premier run 2026-09-02 09:49 UTC ; adapter mis à jour 2026-09-03 13:38-13:41 UTC) | FACTS |
| Contradictions doctrinales listées en §1.4 | VERIFIED (textes cités, chemin:ligne) | R4 ; relecture 2026-09-03 |
| Périmètre D1, exclusions D4, budgets D6, dates D9 | PROPOSED jusqu'à signature | cette ADR |
| Contrôles d'egress du dépôt quantum : non traversés par ce trafic | VERIFIED (trou de couverture) | R4 |

### 7.1 Conformité au régime d'exception de `docs/SSOT/PR_REVIEW_RULES.md` (l.125-134)

| Champ exigé | Statut | Où |
|---|---|---|
| reason | REMPLI | §1.1 |
| exact scope | REMPLI | en-tête Scope, D1 |
| expiry date | REMPLI | en-tête Expiry, D9 |
| approver or machine-quorum evidence | signature §9 (commit vérifié de l'opérateur) | §9 |
| rollback path | REMPLI | D10, runbook |
| evidence that secrets, PII, compliance evidence, financial data, and production state are not exposed | NON REMPLI : secrets présents dans l'environnement hérité du CLI (VERIFIED) ; absence de données de production non auditée (UNVERIFIABLE) | §3, D1, D8 |

Le sixième champ impose, avant la signature ou par acceptation explicite du risque dans la signature : (a) réduire l'environnement hérité par le CLI (§4.2) ; (b) auditer le checkout et les issues accessibles (gitleaks sur l'arbre de travail, revue des pièces jointes, recherche de fixtures dérivées de données réelles), audit daté et joint au miroir quantum. La ligne « Sixième champ » du bloc §9 enregistre l'un ou l'autre. Par ailleurs, l.134 du même SSOT (« An exception cannot authorize … cloud egress bypass ») reste en contradiction ouverte avec cette ADR jusqu'à amendement (§8.6).

## 8. Suivi côté quantum (PR séparée, dépôt privé, chemins sacrés, `prod-gate-required`)

Les suivis détaillés (registre ICT, allowlist, registre souverain, scripts de garde et leurs extensions, ADR liées, CLAUDE.md, manifestes) sont listés dans le miroir privé de cette ADR ; leur cartographie technique n'est pas reproduite ici. Têtes de chapitre, pour référence croisée :

1. `docs/compliance/ict-register.yaml` et ADR-SEC-010 : entrées tiers ICT (OpenCode Go actif ; NVIDIA Build, ModelScope, Z.ai « planned »), catégorie distincte pour l'outillage de développement non souverain, en-tête amendé ; la ligne « cloud egress disabled and EU data residency asserted » cesse d'être vraie.
2. ADR-IA-017 et `docs/governance/sovereign-models-registry.yml` : état externe de développement en section séparée (pas dans `models[]`, pas `authorized: true`), règle zéro-divergence préservée.
3. Les 20 workflows CI qui référencent le runner auto-hébergé du GPU souverain : inventaire et décision. Hors périmètre de cette PR.
4. `CLAUDE.md` : doctrines 2 et 3 scindées entre runtime Quantum/CBS (inchangé) et outillage de développement (déviation datée, renvoi ADR-IA-018) ; checklists pré-PR #5 et #13 ; template de body agent (provider et modèle réels).
5. Miroir de cette ADR dans `docs/adr/ADR-IA-018-mode-cloud-rnd.md` du dépôt quantum, avec les détails omis ici (valeurs d'infrastructure, incident de clé, cartographie des gardes).
6. `docs/SSOT/PR_REVIEW_RULES.md` l.134 : scoper au runtime Quantum/CBS ou assumer la contradiction (RULE-ADR-006 : `prod-gate-required` + revue humaine).
7. `docs/governance/llm-model-allowlist.yml` : bloc `deviations:` non consommé (pointeur ADR-IA-018, expiry) ; annotation de l'`enforced_by` contourné. Aucune entrée dans `allowlist:`.
8. Contrôles d'egress et d'allowlist de la CI quantum : extensions nécessaires (détail dans le miroir privé).
9. ADR-ARCH-003 et ADR-GOV-015 : bandeau « Déviation dev active, voir ADR-IA-018 » ; ADR-GOV-015 §3.4 : trancher si la déclaration du modèle réel dans un body relève du « leak » ou de ses exclusions.
10. Manifestes, commentaires de code et en-têtes de workflows du dépôt quantum décrivant une flotte souveraine qui n'est plus la flotte live : réconcilier ou marquer HISTORICAL.
11. Mémoire opérateur « posture dev full-auto » : amender après signature (elle déclare la souveraineté non waivable en dev).

## 9. Signature

Sans signature, cette ADR n'autorise rien.

Ce que la signature est : la décision et l'autorisation explicite de l'opérateur pour le périmètre D1-D2, au sens de `docs/SSOT/HUMAN_GATES.md` l.38 (« aucun cloud externe autorisé sans approbation explicite ») et la décision humaine d'une ADR séparée au sens du périmètre GREY d'ADR-0042B ; la reconnaissance de cette ADR dans le dépôt quantum passe par le miroir (§8.5), revu selon les règles de ce dépôt. Ce que la signature n'est pas : une approbation de conformité (DORA, RGPD, souveraineté), une approbation de PR (maker-checker), un waiver des SSOT quantum (`PR_REVIEW_RULES.md` l.134 reste en contradiction ouverte jusqu'à amendement, §8.6), ni une approbation émise par l'agent rédacteur.

Forme de la signature : l'opérateur remplit la table ci-dessous dans un commit dont il est l'auteur (compte GitHub `haykel1977`), signé GPG ou SSH et affiché « Verified » par GitHub, poussé sur la branche de cette PR puis mergé sur `main` du fork ; le SHA de ce commit et celui du merge sont reportés dans les lignes « Evidence ». Toute autre inscription est nulle. Dans ce même commit, l'opérateur passe le champ Status à `ACCEPTED-DEV`.

La signature ne peut ni activer un fournisseur de D3, ni lever une exclusion de D4, ni étendre le périmètre D1. Toute extension exige un amendement daté de cette ADR (nouvelle révision, nouvelle signature) et, pour Groq ou xAI, une décision séparée dans le dépôt quantum. Le champ « modifications » ne peut que restreindre.

| Champ | Valeur |
|---|---|
| Nom | |
| Date | |
| Portée acceptée : D1, D2, D4 à D10 (exclusions ou restrictions éventuelles ; D3 = déclaration seulement) | |
| Activation NVIDIA Build (D3) | Non activable par cette signature. Activation = amendement daté + nouvelle signature. |
| Activation ModelScope (D3) | Non activable par cette signature. Activation = amendement daté + nouvelle signature. |
| Activation Z.ai / Zhipu (D3) | Non activable par cette signature. Activation = amendement daté + nouvelle signature. |
| Périmètre ADR-0042B retenu (META ou GREY) | |
| Cursor sur le checkout quantum (D4) : déclaré dans une ligne séparée de D2/§3, ou interdit jusqu'à déclaration | |
| Budgets mensuels retenus (Q-Gov / Q-Impl / Q-Web / QA-Tests), somme ≤ 60 $ | |
| Sixième champ PR_REVIEW_RULES (§7.1) : conditions (a) et (b) réalisées le ___ / ou risque accepté explicitement | |
| Échéance de convergence vers Bifrost (D5) | |
| Définition mesurable de « Quantum prêt » (D9) | |
| Date de réévaluation (≤ 2026-12-02) | |
| Evidence : SHA du commit de signature (« Verified ») | |
| Evidence : SHA du merge sur `main` du fork | |
