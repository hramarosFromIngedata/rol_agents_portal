# Documentation technique — Portail ROL N8N

## 1. Vue d'ensemble

Application Next.js (App Router) servant d'interface de soumission pour un workflow n8n de traitement de documents (OCR + LLM). Le frontend ne parle jamais directement à n8n : toutes les requêtes passent par des routes API Next.js server-side, qui seules connaissent `N8N_HOST`/`N8N_API_KEY`.

```
Navigateur (PortalForm.tsx)
        │  fetch (même origine, jamais vers n8n directement)
        ▼
Routes API Next.js (app/api/**/route.ts)
        │  fetch (avec X-N8N-API-KEY, ou webhook public)
        ▼
n8n (workflows + API REST /api/v1)
```

**Stack** : Next.js 16.2 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS v4. Aucune base de données côté portail — n8n et un Google Sheet (via webhook) sont les seules sources de vérité persistantes.

## 2. Arborescence

```
app/
  layout.tsx                          Layout racine (police, fond, meta)
  page.tsx                            Page unique : <PortalForm /> + footer
  globals.css                         Import Tailwind + styles globaux
  api/
    submit/route.ts                   POST — proxy vers le webhook rol-portal
    form-data/route.ts                GET  — proxy vers fetch-form-data (matricules/langues)
    executions/[id]/status/route.ts   GET  — statut n8n courant d'une exécution
    executions/[id]/stop/route.ts     POST — arrête une exécution (+ sous-exécutions)
    executions/[id]/report/route.ts   GET/POST — construit et stocke le rapport de coût
components/
  PortalForm.tsx                      Composant client principal (formulaire + state machine)
  ConfirmDialog.tsx                   Modale de confirmation générique (Oui/Non)
lib/
  webhooks.ts                         Source unique des chemins de webhooks n8n
  n8n.ts                              Client n8n bas niveau (fetch exécution + arbre de sous-exécutions)
  n8n-report.ts                       Construction du rapport de coût/usage à partir des données n8n
  webhook-retry.ts                    POST avec retry + backoff exponentiel
next.config.ts                        output: "standalone", basePath "/rol"
Dockerfile / docker-compose.yaml      Déploiement conteneurisé
DEPLOY.md                             Procédures de déploiement (Node+systemd et Docker)
```

## 3. Configuration (variables d'environnement)

Définies dans `.env.local` (dev, non commité) ou `.env` (prod Docker, non commité) — voir `.env.local.example` / `.env.example`.

| Variable | Obligatoire | Description |
|---|---|---|
| `N8N_HOST` | Oui | URL de base de l'instance n8n (ex. `https://automate.ingedata.ai`). |
| `N8N_API_KEY` | Oui (sauf `/api/form-data`) | Clé API n8n, utilisée en header `X-N8N-API-KEY` pour l'API REST `/api/v1/*`. |
| `N8N_WEBHOOK_ROL_PORTAL` | Non | Chemin du webhook de soumission (défaut `rol-portal`). |
| `N8N_WEBHOOK_MISTRAL_PRICE` | Non | Chemin du webhook de tarification OCR (défaut `mistral-price`). |
| `N8N_WEBHOOK_OPENROUTER_PRICE` | Non | Chemin du webhook de tarification LLM (défaut `openrouter-price`). |
| `N8N_WEBHOOK_ROL_STORE_META_DATA` | Non | Chemin du webhook de stockage du rapport (défaut `rol-store-meta-data`). |
| `N8N_WEBHOOK_FETCH_FORM_DATA` | Non | Chemin du webhook fournissant matricules/langues (défaut `fetch-form-data`). |
| `APP_PORT` | Non (Docker uniquement) | Port hôte sur lequel `docker-compose` expose le conteneur (défaut `3100`). |

Tous les chemins de webhooks sont résolus par `lib/webhooks.ts` via `webhookUrl(host, name)` → `${host}/webhook/${path}`. C'est la seule source de vérité : renommer un webhook côté n8n ne nécessite qu'une variable d'env, jamais un changement de code.

`next.config.ts` définit `basePath: "/rol"` (l'app est servie sous `/rol`, pas à la racine) et réexpose cette valeur au client via `NEXT_PUBLIC_BASE_PATH`, car Next ne préfixe automatiquement que `next/link`/`next/router`/`next/image` — pas les `fetch()` bruts ni les `<img src>`, d'où la constante `BASE_PATH` utilisée systématiquement dans `PortalForm.tsx`.

## 4. Flux fonctionnel complet

### 4.1 Soumission

1. L'utilisateur remplit le formulaire (`components/PortalForm.tsx`) et clique sur **Traiter**.
2. `handleSubmit` construit un `FormData` avec les champs `url-source`, `langue`, `code`, `categorie`, `document_pdf` — **envoyés systématiquement, même vides** (pas de `if` conditionnel autour des `data.append`), pour que n8n reçoive toujours le jeu de champs complet.
3. `POST /api/submit` (route Next.js) relaie tel quel le `FormData` vers le webhook `rol-portal`, sans le parser (`request.formData()` → `fetch(..., {body: formData})`).
4. Réponse attendue de n8n : `{code: 202, status: "processing", process_id: "<execution_id>"}` (éventuellement enveloppé dans un tableau — les deux formes sont gérées). `process_id` devient l'`executionId` n8n suivi ensuite.
5. Si la réponse ne correspond pas à ce format (autre code), le portail considère l'envoi terminé de façon synchrone (`resetForm()`, statut `finished`) — chemin de repli pour un format de réponse différent, sans exécution n8n à suivre.

### 4.2 Suivi (polling)

`startPolling(pid)` interroge `GET /api/executions/{id}/status` toutes les 3 secondes (`setInterval`), qui lui-même appelle `GET ${N8N_HOST}/api/v1/executions/{id}` (API REST n8n, authentifiée).

Statuts n8n gérés :

| Statut n8n | Comportement portail |
|---|---|
| `new`, `running`, `waiting` | En cours — poursuite du polling. |
| `success` | Arrêt du polling, réinitialisation URL/fichier, **entrée en phase manuelle** (voir 4.3). |
| `error` | Arrêt, statut `error`, message dynamique (voir 4.4), **envoi immédiat du rapport**. |
| `canceled`, `crashed` | Arrêt, statut `error`, message statique, **envoi immédiat du rapport**. |
| *(HTTP 404)* | Exécution introuvable — abandon immédiat, pas de rapport (rien à construire). |
| *(valeur inattendue)* | Statut `error`, message explicite, **aucun** rapport envoyé (aucune source fiable). |

### 4.3 Phase de révision manuelle (uniquement sur succès)

Décision produit explicite : la phase manuelle **ne se déclenche que sur un succès n8n**, jamais sur erreur/annulation (rien à réviser si le traitement a échoué).

- `startManualPhase()` démarre un second chronomètre (`manualElapsedMs`/`manualTimerStartRef`), passe `sendingState` à `"manual"` et `runStatus` à `"manual"`.
- Le bouton "Traiter"/"Annuler" devient **"Valider le traitement manuel"** (même élément de bouton, seul le texte/l'action change selon `sendingState`).
- Le formulaire reste verrouillé (`controlsDisabled = sendingState !== "idle"`).
- Au clic, une modale (`ConfirmDialog`) demande *"Avez-vous eu besoin de corriger manuellement ?"*. La réponse (Oui/Non) déclenche `finalizeManualPhase(manuallyCorrected)` :
  - Capture `manualStartedAt` (depuis la référence exacte du début de phase, pas l'affichage à la seconde près) et `manualStoppedAt` (instant de la réponse).
  - `POST /api/executions/{id}/report` avec `{manualStartedAt, manualStoppedAt, manuallyCorrected}` — **c'est le seul et unique envoi du rapport pour une exécution réussie** (voir 4.4).
  - Retour à `sendingState = "idle"`, bouton → "Traiter".

### 4.4 Rapport d'exécution et stockage

`lib/n8n-report.ts::buildExecutionReport(host, apiKey, executionId)` :

1. `fetchExecutionTree` (dans `lib/n8n.ts`) récupère l'exécution racine **et récursivement tous ses sous-workflows** (`n8n-nodes-base.executeWorkflow`), via `run.metadata.subExecution.executionId` dans `runData`, avec `includeData=true` (nécessaire pour inspecter les E/S de chaque nœud). Ordre retourné : descendants d'abord, racine en dernier.
2. Extraction sur l'arbre complet (`executions[]`), sans dépendre d'un nom de nœud fixe :
   - **`formMetaData`** : `findFieldAnywhere` scanne toutes les sorties de tous les nœuds à la recherche des clés `langue`/`code`/`categorie`/`url-source` (dans `json` ou `json.body`, forme webhook). Le binaire `document_pdf` (nom/taille) est lu sur le **même item** que ce match. `size` utilise `binary.bytes` (nombre exact d'octets) en priorité — `binary.fileSize` est une chaîne formatée (`"614 kB"`) inutilisable telle quelle avec `Number()`.
   - **`ocrAgent`** : tout nœud dont le `type` matche `/mistralAi/i`, lecture de `json.usage_info.pages_processed` (sommé sur tout l'arbre) et `json.model` (dernier rencontré).
   - **`aiAgent`** : tout nœud dont le `type` matche `/openrouter/i`, modèle lu depuis `node.parameters.model` (config statique du nœud), tokens depuis `entry.data.ai_languageModel[0][0].json.tokenUsage`. Regroupé par modèle (`groupAiUsageByModel`) — un objet distinct par modèle si plusieurs sont utilisés, chacun avec son propre prix.
3. Tarification (parallèle, `Promise.all`) :
   - OCR : `fetch(mistral-price)` → `{price: {cost, perPage}}` (éventuellement enveloppé dans un tableau) → `prix = pages × (cost / perPage)`.
   - LLM : `fetch(openrouter-price)` → catalogue `{data: [{id, pricing: {prompt, completion}}]}` (idem, tableau possible) → coût par modèle = `tokens × tarif`, arrondi à 5 décimales (`round5`).
   - Un modèle absent du catalogue, ou un webhook en échec, donne des prix `null` (jamais d'erreur bloquante pour le reste du rapport).
4. `autoStartedAt`/`autoStoppedAt`/`autoProcessingDurationMs` sont calculés **côté serveur** depuis les timestamps n8n (`root.startedAt`/`root.stoppedAt`) — jamais depuis le chrono du navigateur, pour rester corrects quel que soit le moment où le rapport est (re)demandé.
5. `manualStartedAt`/`manualStoppedAt`/`manualProcessingDurationMs`/`manuallyCorrected` sont **toujours `null`** dans `buildExecutionReport` — n8n n'a aucune notion de révision manuelle. Ils ne sont peuplés que par `applyManualCorrection()`, appelé depuis le `POST` de la route.
6. `status_message` : `"executed successfully"` sur succès ; sur échec, `extractErrorMessage` lit `resultData.error.message` (message n8n natif, y compris un message personnalisé de nœud "Stop and Error"), avec repli sur `executionData.nodeExecutionStack` puis `"Erreur inconnue"`.

**Règle d'envoi unique** (`app/api/executions/[id]/report/route.ts`) :

| Route | Déclenchée par | Rôle |
|---|---|---|
| `GET` | Polling, sur `error`/`canceled`/`crashed` uniquement | Construit **et stocke** le rapport (`postJsonWithRetry` vers `rol-store-meta-data`) — seul envoi pour une exécution en échec, aucune phase manuelle à attendre. |
| `POST` | `finalizeManualPhase`, sur succès uniquement | Reconstruit le rapport à jour, fusionne les champs manuels (`applyManualCorrection`), **stocke** — seul envoi pour une exécution réussie. |

Le `GET` n'est **jamais** appelé pour une exécution réussie côté client (voir commentaire dans `PortalForm.tsx` au-dessus de `fetchReport`) : ça éviterait un double envoi (une fois prématurément avec les champs manuels à `null`, une fois après la modale). C'est un bug corrigé explicitement au cours du développement — voir historique git (`baaf93e`).

Le stockage lui-même (`postJsonWithRetry`, `lib/webhook-retry.ts`) est fire-and-forget côté route (ne bloque jamais la réponse HTTP au client), avec retry à backoff exponentiel plafonné (2s → 60s, 8 tentatives max), abandon immédiat sur erreur 4xx non-429 (permanente, pas la peine de réessayer).

### 4.5 Arrêt manuel d'un traitement

Bouton **Annuler** (visible pendant `sendingState === "sending"`) → double confirmation (`ConfirmDialog` x2, la seconde marquée irréversible) → `performStop()` → `POST /api/executions/{id}/stop`.

Cette route (`app/api/executions/[id]/stop/route.ts`) résout d'abord l'arbre complet des sous-exécutions (`fetchExecutionTree`), les arrête une à une (profondeur d'abord), puis arrête l'exécution racine. Best-effort : l'échec d'arrêt d'un enfant déjà terminé n'empêche pas la suite.

`beforeunload`/`unload` (dans `PortalForm.tsx`) : une confirmation navigateur apparaît si l'utilisateur tente de quitter la page pendant `sendingState !== "idle"` (auto **ou** manuel). Si l'utilisateur confirme le départ pendant la phase automatique, `navigator.sendBeacon` déclenche l'arrêt côté serveur (choisi plutôt que `fetch`, qui peut être interrompu pendant le déchargement de la page).

## 5. Machine à états côté client (`PortalForm.tsx`)

```
sendingState: "idle" | "sending" | "manual"

idle ──(Traiter, formulaire valide)──▶ sending
sending ──(succès n8n)──▶ manual
sending ──(échec n8n / arrêt manuel)──▶ idle
manual ──(Oui/Non confirmé)──▶ idle

runStatus: null | "processing" | "manual" | "error" | "finished"
```

État additionnel affiché dans la carte d'informations (`id d'exécution`, 2 chronomètres, `status`, `status_message`), avec une teinte de fond dépendante de `runStatus` (`statusBoxClass`) : neutre (idle/processing), ambre (manual), rouge (error), émeraude (finished) — transition CSS 500ms.

Validation de formulaire (`isFormValid`) : `langue`, `code`, `categorie` non vides, et (`url` seule **ou** fichier seul, jamais les deux) avec une URL syntaxiquement valide. La validation d'URL utilise le constructeur `URL` natif (`isUrlLike`) plutôt qu'une regex — une regex précédente à quantificateurs imbriqués provoquait un blocage du thread (ReDoS) sur certaines URLs réelles (voir historique git).

## 6. API interne — référence

Toutes les routes sont sous `/rol/api/*` en production (`basePath`).

| Méthode | Route | Entrée | Sortie | Rôle |
|---|---|---|---|---|
| `POST` | `/api/submit` | `FormData` (url-source, langue, code, categorie, document_pdf) | Réponse n8n relayée telle quelle | Proxy vers webhook `rol-portal` |
| `GET` | `/api/form-data` | — | `{matricules: number[], langues: string[]}` | Proxy vers webhook `fetch-form-data`, aplati depuis un tableau d'objets |
| `GET` | `/api/executions/[id]/status` | — | `{status: string \| null}` | Statut n8n courant |
| `POST` | `/api/executions/[id]/stop` | — | `{ok: true, stoppedChildren: string[]}` | Arrête l'exécution + sous-exécutions |
| `GET` | `/api/executions/[id]/report` | — | `ExecutionReport` (JSON) | Construit + stocke le rapport (échecs) |
| `POST` | `/api/executions/[id]/report` | `{manualStartedAt, manualStoppedAt, manuallyCorrected}` | `ExecutionReport` (JSON) | Fusionne données manuelles + stocke (succès) |

### Forme de `ExecutionReport`

```ts
{
  executionId: string;
  workflowId: string | null;
  status: "success" | "error";
  status_message: string;
  autoStartedAt: string | null;        // ISO, timestamp n8n
  autoStoppedAt: string | null;        // ISO, timestamp n8n
  autoProcessingDurationMs: number | null;
  manualStartedAt: string | null;      // ISO, fourni par le client
  manualStoppedAt: string | null;      // ISO, fourni par le client
  manualProcessingDurationMs: number | null;
  manuallyCorrected: boolean | null;
  formMetaData: {
    type: "pdf" | "url" | null;
    url: string | null;
    fileName: string | null;
    size: number | null;               // octets exacts
    language: string | null;
    agentId: number | string | null;
    category: string | null;
  };
  ocrAgent: { model: string | null; pagesProcessed: number | null; price: number | null } | null;
  aiAgent: {
    model: string | null;
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
    promptCost: number | null;
    completionCost: number | null;
    totalCost: number | null;
  }[] | null;
}
```

## 7. Dépendances externes (webhooks n8n)

| Webhook (défaut) | Méthode | Rôle | Format attendu |
|---|---|---|---|
| `rol-portal` | POST | Reçoit la soumission du formulaire, lance le traitement | `{code: 202, status: "processing", process_id}` (bare ou tableau) |
| `fetch-form-data` | GET | Fournit les options des listes déroulantes | `[{matricules: number[]}, {langues: string[]}]` (ou fusionné) |
| `mistral-price` | GET | Tarif OCR courant | `{price: {cost, perPage}}` (bare ou tableau) |
| `openrouter-price` | GET | Catalogue de tarifs LLM | `{data: [{id, pricing: {prompt, completion}}]}` (bare ou tableau) |
| `rol-store-meta-data` | POST | Stocke le rapport final (sheet) | Corps = `ExecutionReport` complet |

Tous ces webhooks sont interrogés directement par le serveur Next.js (jamais par le navigateur), avec gestion défensive du fait que n8n peut répondre soit avec l'objet nu, soit enveloppé dans un tableau à un élément — cause de plusieurs bugs déjà corrigés dans l'historique (voir §9).

## 8. Déploiement

Voir `DEPLOY.md` pour la procédure complète. Deux méthodes supportées :

1. **Node + systemd** : build `output: "standalone"` (Next.js), transfert de `.next/standalone/`, `.next/static/`, `public/` vers le serveur, service systemd, Nginx en reverse proxy (TLS via Certbot).
2. **Docker** : `Dockerfile` multi-stage réutilisant le même `output: "standalone"`, `docker-compose.yaml` avec port hôte configurable (`APP_PORT`, jamais `3000` en dur, bindé sur `127.0.0.1` uniquement) pour éviter les conflits sur un serveur mutualisé.

Dans les deux cas, **aucun déploiement automatique** : un `git push` ne met pas à jour le serveur qui tourne, il faut explicitement rebuild + redémarrer (`docker compose up -d --build` ou build+rsync+`systemctl restart`).

## 9. Historique des bugs notables (pour référence future)

- **ReDoS sur la regex de validation d'URL** : quantificateur imbriqué provoquant un blocage du thread sur certaines URLs réelles → remplacé par le constructeur `URL` natif.
- **`fileSize` vs `bytes`** : n8n stocke la taille de fichier sous deux formes (`fileSize` = chaîne formatée type `"614 kB"`, `bytes` = nombre exact) — le code lisait le mauvais champ, donnant systématiquement `size: null`.
- **Webhooks de tarification enveloppés dans un tableau** : `mistral-price` et `openrouter-price` répondent avec `[{...}]`, pas l'objet nu attendu initialement — cause de prix `null` malgré une exécution correcte, corrigé en gérant les deux formes.
- **Double envoi du rapport** : le rapport d'une exécution réussie était stocké une première fois (prématurément, champs manuels à `null`) puis une seconde fois après la validation manuelle — corrigé en ne stockant qu'une fois, au bon moment selon l'issue (échec → `GET` immédiat ; succès → `POST` après validation manuelle).
- **Contenu inaccessible sur petits écrans** : `overflow-hidden` + hauteur figée (`h-dvh`) rendait le bas du formulaire invisible et impossible à atteindre dès que le contenu dépassait la hauteur de viewport (mobile, ou desktop bas de gamme) — remplacé par `min-h-dvh` (scroll de repli).
