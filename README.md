# quota-cli

CLI natif (Node ≥ 20, zéro dépendance) qui affiche les quotas d'abonnement **OpenCode Go**, **Codex (ChatGPT Plus/Pro)** et **Hyper (Charm)** dans le terminal — port hors-[opencode](https://opencode.ai/) du plugin [opencode-quota-go-codex](https://github.com/benjaminbach-dev/opencode-quota-go-codex).

La clé OpenCode Go est lue **dans la configuration de [ccp-proxy](https://github.com/claude-code-proxy)** : la commande reflète le compte réellement consommé par le proxy Claude.

## Usage

```sh
quota              # les trois providers, rendu terminal (couleurs ANSI)
quota go           # OpenCode Go seulement (compte proxy)
quota codex        # Codex seulement
quota hyper        # Hyper (Charm) seulement
quota --compact    # une ligne par provider
quota --markdown   # rendu markdown identique au plugin
```

## Sources de credentials

| Provider | Source | Fallback |
|---|---|---|
| OpenCode Go | config ccp-proxy `~/.config/claude-code-proxy/config.json` → `opencode.apiKey` | `~/.local/share/opencode/auth.json` (entrée `opencode-go`) |
| Codex | `~/.local/share/opencode/auth.json` (OAuth ChatGPT) | — |
| Hyper (Charm) | `HYPER_API_KEY` | `~/.local/share/opencode/auth.json` (entrée `hyper`) |

Chemin proxy surchargeable : `--proxy-config <path>` ou `QUOTA_PROXY_CONFIG`.

## Fonctionnement

- `GET https://opencode.ai/zen/go/v1/usage` + `GET https://chatgpt.com/backend-api/wham/usage` + `GET https://hyper.charm.land/v1/credits` en parallèle, timeout 15 s.
- Cache disque 60 s par provider (`~/.cache/quota-cli/cache.json`, XDG respecté — succès uniquement) ; le délai de reset est recalculé à chaque rendu.
- Erreurs contrôlées par provider, secrets jamais affichés (ni intégralement ni partiellement).
- 401 → inviter à relancer `opencode auth login` (ou vérifier `HYPER_API_KEY` pour Hyper).
- Hyper : le rendu est une fenêtre `daily` en pourcentage **consommé** du quota du plan ($20/mois = 250 Hypercredits/jour) — `(250 - balance) / 250 × 100`. L'API ne renvoie que `{balance}`, sans heure de recharge (reset « — »). Si la balance dépasse 250 (bundles prépayés), `daily` est plafonné à 0 % et une fenêtre `credits` affiche le surplus (`+N credits (bundle)`).

Voir [openspec/specs/quota-cli/spec.md](openspec/specs/quota-cli/spec.md).
