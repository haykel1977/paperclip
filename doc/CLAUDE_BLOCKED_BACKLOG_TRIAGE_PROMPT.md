# Prompt Claude — triage du backlog bloqué Paperclip

Copiez le prompt ci-dessous dans Claude disposant d'un accès administrateur à l'instance Paperclip cible.

---

Tu interviens comme opérateur de triage sur l'instance Paperclip `https://quantum-dev.kantum.dev`.

## Objectif

Réduire les tâches bloquées et les revues opérateur sans contourner les contrôles de sécurité, sans masquer du travail humain et sans fermer une tâche qui n'est pas démontrée comme terminée ou obsolète.

## Contraintes impératives

- Utilise uniquement des modèles d'agents souverains.
- Utilise l'API Paperclip authentifiée; ne lis ni ne modifies directement la base de données, sauf demande explicite pour une analyse en lecture seule.
- Ne révèle jamais les jetons, cookies, clés, variables d'environnement ou détails externes déjà expurgés.
- Reste strictement dans l'entreprise sélectionnée; vérifie le `companyId` avant chaque mutation.
- Commence par un dry-run. Ne réalise aucune mutation en masse avant d'avoir présenté le plan, les volumes et des exemples représentatifs.
- Ne contourne aucune approbation, protection de branche, pause, hold, limite de retry ou décision humaine.
- Ne modifie pas automatiquement une tâche ayant une interaction, une approbation ou une décision utilisateur en attente.
- Ne considère pas `open_recovery_issue`, `missing_successful_run_disposition` ou `blocked_by_assigned_backlog_issue` comme du travail humain si un agent actif possède déjà un chemin d'exécution valide.
- Toute correction de code découverte doit devenir une issue et une PR ciblées; aucun changement direct sur la branche protégée.

## Phase 1 — état initial en lecture seule

1. Identifie l'entreprise cible et son `companyId`.
2. Appelle `GET /api/companies/{companyId}/issues/blocked-summary`.
3. Récupère les tâches concernées avec `GET /api/companies/{companyId}/issues?attention=blocked&includeBlockedInboxAttention=true&includeBlockedBy=true`, en paginant jusqu'à la fin.
4. Vérifie que le total paginé correspond au total du résumé.
5. Produis un tableau :

   `cause | nombre | ancienneté médiane | chemin de traitement | action sûre proposée`

6. Signale séparément :
   - décisions humaines ou externes;
   - workflows déjà possédés par un agent;
   - triage opérateur réellement nécessaire;
   - tâches âgées de plus de 24 heures;
   - doublons potentiels, sans encore les fermer.
7. Sélectionne les deux causes les plus volumineuses pouvant être réduites sans décision métier.

## Phase 2 — plan de mutations sûres

Présente un dry-run détaillé, avec les identifiants des tâches, pour les actions suivantes uniquement :

- retirer un blocage devenu caduc lorsque la dépendance est déjà terminale et que l'API confirme qu'aucune autre dépendance active ne subsiste;
- remettre en file un blocker `backlog` déjà assigné seulement si son agent est actif, qu'aucun hold/pause ne s'applique et qu'aucun run actif ou retry planifié n'existe;
- lancer un retry uniquement pour une erreur explicitement transitoire, sous le plafond de retries et sans run concurrent;
- réassigner une tâche orpheline seulement lorsqu'un propriétaire recommandé unique et invocable est fourni par Paperclip;
- regrouper les doublons seulement si le lien de duplication est démontré; conserver une tâche canonique et transférer les dépendances avant toute fermeture.

Toute autre situation reste en revue humaine. En particulier, ne décide jamais automatiquement une approbation, une question utilisateur, une attente externe, un changement de permissions, une migration destructive ou un conflit de portée.

## Phase 3 — exécution contrôlée

Après validation explicite du dry-run :

1. Exécute les mutations par lots de 10 maximum.
2. Après chaque lot, relis les tâches modifiées et vérifie les relations, propriétaires, runs et interactions.
3. Arrête immédiatement le lot en cas de réponse inattendue, de conflit, de changement concurrent ou de hausse du nombre de blocages.
4. N'effectue pas plus d'une mutation automatique par tâche dans le même passage.
5. Laisse une trace d'audit concise indiquant la cause, la preuve et l'action réalisée, sans donnée sensible.

## Phase 4 — validation et rapport

1. Relance le résumé de triage et compare avant/après.
2. Vérifie qu'aucune tâche n'a été fermée sans preuve, qu'aucune interaction humaine n'a été perdue et qu'aucun run concurrent n'a été créé.
3. Fournis :
   - volumes avant/après par cause;
   - nombre de tâches prises en charge par les agents;
   - nombre nécessitant encore un opérateur;
   - mutations réussies, ignorées ou annulées;
   - erreurs et anomalies;
   - recommandations d'automatisation récurrente.
4. Crée des issues séparées pour les défauts de produit observés. N'élargis pas la portée d'une PR existante.

## Critères de réussite

- baisse mesurable de `operatorAttentionCount`;
- aucune régression de sécurité ou de permissions;
- aucune tâche incorrectement fermée;
- aucun secret dans les sorties;
- toutes les décisions humaines restent explicites;
- rapport reproductible avec les identifiants et preuves nécessaires.

Commence maintenant par la Phase 1 uniquement et attends une validation explicite avant toute mutation.
