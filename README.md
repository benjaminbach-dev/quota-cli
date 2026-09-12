# quota-cli

CLI natif (Node ≥ 20, zéro dépendance) qui affiche les quotas d'abonnement **OpenCode Go** et **Codex (ChatGPT Plus/Pro)** dans le terminal — port hors-[opencode](https://opencode.ai/) du plugin [opencode-quota-go-codex](https://github.com/benjaminbach-dev/opencode-quota-go-codex).

La clé OpenCode Go est lue **dans la configuration de [ccp-proxy](https://github.com/claude-code-proxy)** : la commande reflète le compte réellement consommé par le proxy Claude.

## Usage

```sh
quota              # les deux providers, rendu terminal (couleurs ANSI)
quota go           # OpenCode Go seulement (compte proxy)
quota codex        # Codex seulement
quota --compact    # une ligne par provider
quota --markdown   # rendu markdown identique au plugin
```

## Sources de credentials

| Provider | Source | Fallback |
|---|---|---|
| OpenCode Go | config ccp-proxy `~/.config/claude-code-proxy/config.json` → `opencode.apiKey` | `~/.local/share/opencode/auth.json` (entrée `opencode-go`) |
| Codex | `~/.local/share/opencode/auth.json` (OAuth ChatGPT) | — |

Chemin proxy surchargeable : `--proxy-config <path>` ou `QUOTA_PROXY_CONFIG`.

## Fonctionnement

- `GET https://opencode.ai/zen/go/v1/usage` + `GET https://chatgpt.com/backend-api/wham/usage` en parallèle, timeout 15 s.
- Cache disque 60 s par provider (`~/.cache/quota-cli/cache.json`, XDG respecté — succès uniquement) ; le délai de reset est recalculé à chaque rendu.
- Erreurs contrôlées par provider, secrets jamais affichés (ni intégralement ni partiellement).
- 401 → inviter à relancer `opencode auth login`.

Voir [openspec/specs/quota-cli/spec.md](openspec/specs/quota-cli/spec.md).
