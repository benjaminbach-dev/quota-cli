# quota-cli Specification

## Purpose

Fournir une commande CLI native (Node ≥ 20, zéro dépendance) qui affiche les quotas d'abonnement **OpenCode Go** et **Codex (ChatGPT Plus/Pro)** dans un terminal — port hors-opencode du module de quotas du plugin `opencode-quota-go-codex`. La clé OpenCode Go est lue depuis la configuration de ccp-proxy : la commande reflète donc le compte réellement consommé par le proxy Claude.

## Requirements

### Requirement: Sources de credentials en priorité proxy
Le CLI SHALL lire la clé API OpenCode Go en priorité dans la configuration ccp-proxy (`~/.config/claude-code-proxy/config.json`, chemin `opencode.apiKey`), ce chemin étant surchargeable par l'option `--proxy-config <path>` ou la variable d'environnement `QUOTA_PROXY_CONFIG`. Si cette source est absente ou inexploitable, le CLI SHALL retomber sur `~/.local/share/opencode/auth.json` (respect de `XDG_DATA_HOME`) avec le même algorithme que le plugin (aliases `opencode-go`, champs `key`/`token`). Les credentials Codex SHALL être lus uniquement depuis `auth.json` (aliases `openai`/`codex`/`chatgpt`, `access`/`token` + `accountId`). La clé API Hyper (Charm) SHALL être lue depuis la variable d'environnement `HYPER_API_KEY` en priorité, puis depuis `auth.json` (alias `hyper`, champs `key`/`token`).

#### Scenario: Clé présente dans la config proxy
- **WHEN** `~/.config/claude-code-proxy/config.json` contient `opencode.apiKey` non vide
- **THEN** la clé proxy est utilisée pour l'appel à l'API OpenCode Go et `auth.json` n'est pas consulté pour ce provider

#### Scenario: Config proxy absente
- **WHEN** le fichier de config proxy est absent, invalide ou sans `opencode.apiKey`
- **THEN** le CLI tente la lecture d'`auth.json` (entrée `opencode-go`) avant de signaler « non configure »

#### Scenario: Chemin surchargé
- **WHEN** l'utilisateur passe `--proxy-config /chemin/custom.json` ou définit `QUOTA_PROXY_CONFIG`
- **THEN** ce chemin remplace le chemin par défaut pour la source Go

### Requirement: Récupération des quotas
Le CLI SHALL interroger `GET https://opencode.ai/zen/go/v1/usage` (header `Authorization: Bearer <key>`, `x-opencode-session`, `Accept: application/json`) et `GET https://chatgpt.com/backend-api/wham/usage` (header `Authorization: Bearer <access>`, `ChatGPT-Account-Id: <accountId>`), avec un timeout de 15 s par appel, les deux providers étant interrogés en parallèle. Le parsing SHALL suivre la logique du plugin : fenêtres Go `rolling`/`weekly`/`monthly` (`{percent, resetsAt}`), fenêtres Codex `rate_limit.primary_window`/`secondary_window` (label via `limit_window_seconds`, `604800` → `weekly`) et `credits` (`Unlimited` ou `$<balance>`), epoch `< 1e12` converti ×1000, `used_percent` non fini ignoré, clamp 0–100.

#### Scenario: Rendu complet des deux providers
- **WHEN** les deux endpoints répondent avec des données valides
- **THEN** les fenêtres Go (5h, weekly, monthly) et Codex (5h, weekly, credits) sont affichées avec usage, barre et délai de reset

#### Scenario: 401 sur un provider
- **WHEN** l'API Go renvoie 401/403 ou l'API Codex renvoie 401
- **THEN** le CLI affiche un message invitant à relancer `opencode auth login` sans interrompre l'autre provider

#### Scenario: Données inexploitables
- **WHEN** la réponse contient un JSON invalide, des fenêtres sans pourcentage exploitable ou une structure inattendue
- **THEN** le provider est signalé « donnees inexploitables » sans crash ni fuite d'exception brute

### Requirement: Confidentialité des secrets
Le CLI MUST NOT afficher, logger ou renvoyer la clé API ou le token OAuth, ni partiellement ni intégralement, y compris dans les messages d'erreur. Les messages d'erreur SHALL être générés localement (auth, HTTP, timeout « delai d'attente depasse (15s) », réseau) et les exceptions brutes MUST NOT être propagées à l'affichage.

#### Scenario: Erreur réseau avec token malformé
- **WHEN** le credential contient des caractères de contrôle et provoque un `TypeError` fetch
- **THEN** l'affichage se limite à « erreur reseau » et aucune portion du credential n'apparaît

### Requirement: Cache et fraîcheur du reset
Le CLI SHALL mettre en cache le résultat de chaque provider dans un **cache disque** (`~/.cache/quota-cli/cache.json`, respect de `XDG_CACHE_HOME`) pendant 60 s (succès uniquement), afin de tolérer les invocations rapprochées — chaque invocation étant un processus distinct. Le délai de reset SHALL être recalculé à chaque rendu à partir du `resetAt` absolu, de sorte qu'il progresse même lorsque le résultat vient du cache.

#### Scenario: Deux invocations rapprochées
- **WHEN** la commande est invoquée deux fois à moins de 60 s d'intervalle
- **THEN** le second rendu est servi du cache et le délai de reset affiché a diminué d'autant

### Requirement: Interface en ligne de commande
Le CLI SHALL accepter : une sélection de provider (`go`, `codex`, positionnel ou option), un mode `--compact` (une ligne par provider) et `--markdown` (rendu markdown identique au plugin, barres `█░` de 12 caractères, tableau `| Fenetre | Utilise | Barre | Reset |`). Le rendu par défaut SHALL être adapté au terminal : colonnes alignées et couleurs ANSI (vert < 50 %, jaune 50–79 %, rouge ≥ 80 %, limite atteinte signalée). Une valeur de provider inconnue SHALL produire une erreur listant les valeurs acceptées (code de sortie non nul). Les alertes (⚠️ ≥ 50 %, 🚨 ≥ 80 %, limite atteinte à 100 %) SHALL être reproduites en mode markdown comme le plugin, et transposées en couleurs ANSI en mode terminal.

#### Scenario: Commande par défaut
- **WHEN** le CLI est invoqué sans argument
- **THEN** les deux providers sont affichés en rendu terminal couleur

#### Scenario: Mode markdown
- **WHEN** le CLI est invoqué avec `--markdown`
- **THEN** la sortie est identique à celle du plugin `opencode-quota-go-codex` pour les mêmes données

#### Scenario: Provider invalide
- **WHEN** le CLI est invoqué avec un provider inconnu
- **THEN** il affiche les valeurs acceptées (`go`, `codex`, `all`) et termine avec un code non nul

### Requirement: Erreurs contrôlées isolées par provider
Chaque provider SHALL être exécuté dans son propre bloc d'erreur : l'échec d'un provider (credential absent, HTTP, timeout, réseau, parse) SHALL produire un message dédié (`### <Nom> — ✗ <message>`) sans empêcher le rendu de l'autre.

#### Scenario: Codex non configure
- **WHEN** `auth.json` ne contient aucune entrée `openai`/`codex`/`chatgpt`
- **THEN** le rendu Codex affiche « non configure — lancer `opencode auth login` » et le rendu OpenCode Go reste intact

### Requirement: Provider Hyper (Charm)
Le CLI SHALL interroger `GET https://hyper.charm.land/v1/credits` (header `Authorization: Bearer <clé>`) pour le provider `hyper` et exposer la sélection `hyper` en plus de `go`/`codex`/`all`. La réponse (`{balance}` en Hypercredits) SHALL être rendue comme une valeur de type credits (valeur numérique, pas de barre), le plan de l'abonnement (20 $/mois = 250 Hypercredits rafraîchis quotidiennement) servant à dériver un pourcentage de consommation lorsque possible. Les erreurs SHALL suivre le même traitement contrôlé que les autres providers (401 → message « relancer l'authentification Hyper », timeout 15 s, aucune fuite de la clé).

#### Scenario: Balance Hyper affichée
- **WHEN** l'API credits répond avec `{"balance": 187}`
- **THEN** le rendu affiche la balance restante en Hypercredits (et, si dérivable, le pourcentage consommé du quota du plan)

#### Scenario: Hyper non configure
- **WHEN** `HYPER_API_KEY` est absente et `auth.json` n'a pas d'entrée `hyper`
- **THEN** le rendu Hyper affiche « non configure — définir HYPER_API_KEY » et les autres providers restent intacts
