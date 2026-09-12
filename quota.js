#!/usr/bin/env node
// quota-cli — quotas OpenCode Go (compte proxy ccp) + Codex (ChatGPT Plus/Pro)
// Port hors-opencode du plugin opencode-quota-go-codex. Zéro dépendance, Node >= 20.

import fs from "fs"
import os from "os"
import path from "path"

// ---------------------------------------------------------------- arguments

const USAGE = `Usage: quota [go|codex|all] [--compact] [--markdown] [--terminal] [--proxy-config <path>]

  provider      go | codex | all (défaut : all)
  --compact     une ligne par provider
  --markdown    rendu markdown (identique au plugin opencode-quota-go-codex)
  --terminal    rendu terminal couleur (défaut, forcé hors TTY si --markdown absent)
  --proxy-config <path>  chemin de la config ccp-proxy
                         (défaut : ~/.config/claude-code-proxy/config.json,
                          surcharge aussi possible via QUOTA_PROXY_CONFIG)
  --help        cette aide`

const argv = process.argv.slice(2)
let provider = "all"
let mode = "full"
let output = "terminal"
let proxyConfigOverride = null

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--compact") mode = "compact"
  else if (a === "--markdown") output = "markdown"
  else if (a === "--terminal") output = "terminal"
  else if (a === "--proxy-config") {
    if (i + 1 >= argv.length) {
      console.error("--proxy-config : chemin manquant")
      process.exit(1)
    }
    proxyConfigOverride = argv[++i]
  } else if (a === "--help" || a === "-h") {
    console.log(USAGE)
    process.exit(0)
  } else if (a === "go" || a === "codex" || a === "all") {
    provider = a
  } else {
    console.error(
      `Argument inconnu : "${a}".\nProvider accepté : go, codex, all. Options : --compact, --markdown, --proxy-config <path>, --help.`,
    )
    process.exit(1)
  }
}

// ---------------------------------------------------------------- couleurs

const colorEnabled =
  output !== "markdown" &&
  process.stdout.isTTY &&
  !process.env.NO_COLOR &&
  !(process.env.TERM || "").startsWith("dumb")

const ansi = (code, text) => (colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text)
const bold = (t) => ansi(1, t)
const dim = (t) => ansi(2, t)
const red = (t) => ansi(31, t)
const green = (t) => ansi(32, t)
const yellow = (t) => ansi(33, t)
const colorFor = (percent) =>
  percent >= 80 ? red : percent >= 50 ? yellow : green

// ---------------------------------------------------------------- chemins & auth

const AUTH_PATH = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"),
  "opencode",
  "auth.json",
)

const PROXY_CONFIG_PATH =
  proxyConfigOverride ||
  process.env.QUOTA_PROXY_CONFIG ||
  path.join(os.homedir(), ".config", "claude-code-proxy", "config.json")

const CACHE_PATH = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "quota-cli",
  "cache.json",
)

const CACHE_TTL_MS = 60_000

const readAuth = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const getEntry = (auth, aliases) => {
  for (const alias of aliases) {
    if (auth && typeof auth === "object" && auth[alias]) return auth[alias]
  }
  return null
}

// Clé OpenCode Go : config ccp-proxy en priorité, auth.json en repli.
const readGoKey = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, "utf8"))
    const key = parsed && typeof parsed === "object" ? parsed.opencode?.apiKey : null
    if (typeof key === "string" && key.trim()) return { key, source: "proxy" }
  } catch {
    // config proxy absente ou invalide → repli auth.json
  }
  const entry = getEntry(readAuth(), ["opencode-go"])
  if (!entry) return null
  const key = typeof entry === "string" ? entry : entry?.key ?? entry?.token
  return typeof key === "string" && key.trim() ? { key, source: "auth.json" } : null
}

// Credentials Codex : auth.json uniquement.
const readCodexCredentials = () => {
  const entry = getEntry(readAuth(), ["openai", "codex", "chatgpt"])
  if (!entry) return null
  if (typeof entry !== "object") return null
  const accessToken = entry.access ?? entry.token
  return typeof accessToken === "string" && accessToken.trim()
    ? { accessToken, accountId: entry.accountId }
    : null
}

// ---------------------------------------------------------------- parsing

const toTimestamp = (value) => {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1_000_000_000_000 ? value * 1000 : value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

const resolveWindowLabel = (windowSeconds) => {
  if (!windowSeconds) return "tokens"
  if (windowSeconds % 86400 === 0) {
    const days = windowSeconds / 86400
    return days === 7 ? "weekly" : `${days}d`
  }
  if (windowSeconds % 3600 === 0) return `${windowSeconds / 3600}h`
  return `${windowSeconds}s`
}

const makeWindow = ({ usedPercent, resetAt, windowSeconds, valueLabel }) => {
  const hasPercent = typeof usedPercent === "number" && Number.isFinite(usedPercent)
  const resetMs = toTimestamp(resetAt)
  return {
    usedPercent: hasPercent ? Math.min(100, Math.max(0, usedPercent)) : null,
    remainingPercent: hasPercent
      ? Math.max(0, 100 - Math.min(100, Math.max(0, usedPercent)))
      : null,
    windowSeconds: windowSeconds ?? null,
    resetAt: resetMs,
    valueLabel: valueLabel ?? null,
  }
}

class ControlledError extends Error {
  constructor(message) {
    super(message)
    this.name = "ControlledError"
  }
}

const controlledError = (error) => {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return "delai d'attente depasse (15s)"
    if (error.name === "TypeError") return "erreur reseau"
  }
  return "erreur inattendue"
}

const formatMoney = (value) => {
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

// ---------------------------------------------------------------- fetch providers

const fetchOpenCodeGo = async (apiKey) => {
  const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-opencode-session": "quota-cli",
      "User-Agent": "quota-cli",
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 401 || response.status === 403)
    throw new ControlledError(
      "authentification OpenCode Go echouee — relancer `opencode auth login`",
    )
  if (!response.ok) throw new ControlledError(`API OpenCode Go: HTTP ${response.status}`)
  const payload = await response.json().catch(() => null)
  const usage = payload && typeof payload === "object" ? payload.usage : null
  if (!usage || typeof usage !== "object")
    throw new ControlledError("donnees OpenCode Go inexploitables")
  const windows = {}
  for (const [label, field] of [
    ["5h", "rolling"],
    ["weekly", "weekly"],
    ["monthly", "monthly"],
  ]) {
    const entry = usage[field]
    if (!entry || typeof entry !== "object") continue
    if (typeof entry.percent !== "number" || !Number.isFinite(entry.percent)) continue
    if (
      typeof entry.resetsAt !== "string" ||
      !Number.isFinite(new Date(entry.resetsAt).getTime())
    )
      continue
    windows[label] = makeWindow({ usedPercent: entry.percent, resetAt: entry.resetsAt })
  }
  if (Object.keys(windows).length === 0)
    throw new ControlledError("donnees OpenCode Go inexploitables")
  return windows
}

const fetchCodex = async (accessToken, accountId) => {
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 401)
    throw new ControlledError("session expiree — relancer `opencode auth login` (ChatGPT)")
  if (!response.ok) throw new ControlledError(`API Codex: HTTP ${response.status}`)
  const payload = await response.json().catch(() => null)
  const rateLimit = payload && typeof payload === "object" ? payload.rate_limit : null
  if (!rateLimit) throw new ControlledError("donnees Codex inexploitables")
  const windows = {}
  for (const window of [rateLimit.primary_window, rateLimit.secondary_window]) {
    if (!window || typeof window !== "object") continue
    if (typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent))
      continue
    const seconds =
      typeof window.limit_window_seconds === "number" &&
      Number.isFinite(window.limit_window_seconds)
        ? window.limit_window_seconds
        : null
    windows[resolveWindowLabel(seconds)] = makeWindow({
      usedPercent: window.used_percent,
      resetAt: window.reset_at,
      windowSeconds: seconds,
    })
  }
  const credits = payload.credits
  if (credits && typeof credits === "object") {
    const label =
      credits.unlimited
        ? "Unlimited"
        : typeof credits.balance === "number" && Number.isFinite(credits.balance)
          ? `$${formatMoney(credits.balance)}`
          : null
    if (label) windows.credits = makeWindow({ usedPercent: null, valueLabel: label })
  }
  if (Object.keys(windows).length === 0)
    throw new ControlledError("donnees Codex inexploitables")
  return windows
}

// ---------------------------------------------------------------- cache disque

const readCache = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const writeCache = (cache) => {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache))
  } catch {
    // cache best-effort : échec d'écriture silencieux
  }
}

// ---------------------------------------------------------------- orchestration

const PROVIDERS = {
  go: { id: "go", name: "OpenCode Go" },
  codex: { id: "codex", name: "Codex" },
}

const fetchProvider = async (key) => {
  // cache disque 60 s (succès uniquement), tolère plusieurs invocations rapprochées
  const cache = readCache()
  const cached = cache[key.id]
  if (cached && typeof cached.at === "number" && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result
  }
  let result
  try {
    if (key.id === "go") {
      const cred = readGoKey()
      if (!cred) result = { name: key.name, ok: false, error: "non configure — lancer `opencode auth login`" }
      else result = { name: key.name, ok: true, source: cred.source, windows: await fetchOpenCodeGo(cred.key) }
    } else {
      const cred = readCodexCredentials()
      if (!cred) result = { name: key.name, ok: false, error: "non configure — lancer `opencode auth login`" }
      else result = { name: key.name, ok: true, windows: await fetchCodex(cred.accessToken, cred.accountId) }
    }
  } catch (error) {
    result = {
      name: key.name,
      ok: false,
      error:
        error instanceof ControlledError && error.message
          ? error.message
          : controlledError(error),
    }
  }
  if (result.ok) {
    cache[key.id] = { at: Date.now(), result }
    writeCache(cache)
  }
  return result
}

// ---------------------------------------------------------------- rendu

const WINDOW_ORDER = ["5h", "weekly", "monthly", "credits"]

const orderedWindows = (windows) =>
  Object.keys(windows).sort((a, b) => {
    const ia = WINDOW_ORDER.indexOf(a)
    const ib = WINDOW_ORDER.indexOf(b)
    return (ia === -1 ? WINDOW_ORDER.length : ia) - (ib === -1 ? WINDOW_ORDER.length : ib)
  })

const resetDelaySeconds = (window) => {
  if (typeof window.resetAt !== "number" || !Number.isFinite(window.resetAt)) return null
  return Math.max(0, Math.floor((window.resetAt - Date.now()) / 1000))
}

const formatReset = (window) => {
  const seconds = resetDelaySeconds(window)
  if (typeof seconds !== "number") return "—"
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (seconds < 60) return `${seconds}s`
  if (days > 0) return hours > 0 ? `${days}j ${hours}h` : `${days}j`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

const bar = (usedPercent, width = 12) => {
  if (typeof usedPercent !== "number") return "".padEnd(width, "░")
  const filled = Math.round((Math.min(100, Math.max(0, usedPercent)) / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

// rendu markdown — identique au plugin opencode-quota-go-codex
const renderFullMarkdown = (result) => {
  if (!result.ok) return `### ${result.name} — ✗ ${result.error}`
  const lines = [
    `### ${result.name}`,
    "",
    "| Fenetre | Utilise | Barre | Reset |",
    "|---|---|---|---|",
  ]
  const labels = orderedWindows(result.windows)
  for (const label of labels) {
    const window = result.windows[label]
    if (window.valueLabel) {
      lines.push(`| ${label} | — | — | ${window.valueLabel} |`)
      continue
    }
    lines.push(
      `| ${label} | ${Math.round(window.usedPercent)}% | ${bar(window.usedPercent)} | ${formatReset(window)} |`,
    )
  }
  for (const label of labels) {
    const used = result.windows[label].usedPercent
    if (typeof used !== "number") continue
    if (used >= 100) lines.push("", `🚨 **${label} : limite atteinte**`)
    else if (used >= 80) lines.push("", `🚨 ${label} à ${Math.round(used)}% — attention`)
    else if (used >= 50)
      lines.push("", `⚠️ ${label} à ${Math.round(used)}% — ralentissez le rythme`)
  }
  return lines.join("\n")
}

const renderCompactMarkdown = (result) => {
  if (!result.ok) return `**${result.name}** — ✗ ${result.error}`
  const parts = orderedWindows(result.windows).map((label) => {
    const window = result.windows[label]
    if (window.valueLabel) return `${label} ${window.valueLabel}`
    return `${label} ${Math.round(window.usedPercent)}% (reset ${formatReset(window)})`
  })
  return `**${result.name}** — ${parts.join(" · ")}`
}

// rendu terminal — colonnes alignées, barres colorées par seuil
const renderFullTerminal = (result) => {
  if (!result.ok) return `${result.name} — ✗ ${result.error}`
  const lines = []
  if (result.source === "proxy") lines.push(bold(result.name) + dim("  (compte proxy ccp)"))
  else lines.push(bold(result.name))
  for (const label of orderedWindows(result.windows)) {
    const window = result.windows[label]
    if (window.valueLabel) {
      lines.push(`  ${label.padEnd(8)} ${window.valueLabel}`)
      continue
    }
    const used = Math.round(window.usedPercent)
    lines.push(
      `  ${label.padEnd(8)} ${colorFor(window.usedPercent)(bar(window.usedPercent))}` +
        ` ${String(used).padStart(3)}%` +
        (resetDelaySeconds(window) !== null ? dim(`  reset ${formatReset(window)}`) : "  reset —"),
    )
  }
  for (const label of orderedWindows(result.windows)) {
    const used = result.windows[label].usedPercent
    if (typeof used !== "number") continue
    if (used >= 100) lines.push("", red(`🚨 ${label} : limite atteinte`))
    else if (used >= 80) lines.push("", red(`🚨 ${label} à ${Math.round(used)}% — attention`))
    else if (used >= 50)
      lines.push("", yellow(`⚠️ ${label} à ${Math.round(used)}% — ralentissez le rythme`))
  }
  return lines.join("\n")
}

const renderCompactTerminal = (result) => {
  if (!result.ok) return `${result.name} — ✗ ${result.error}`
  const parts = orderedWindows(result.windows).map((label) => {
    const window = result.windows[label]
    if (window.valueLabel) return `${label} ${window.valueLabel}`
    const used = Math.round(window.usedPercent)
    return (
      `${label} ` +
      colorFor(window.usedPercent)(`${used}%`) +
      ` (reset ${formatReset(window)})`
    )
  })
  return `${bold(result.name)} — ${parts.join(" · ")}`
}

// ---------------------------------------------------------------- sortie

const selected =
  provider === "all" ? [PROVIDERS.go, PROVIDERS.codex] : [PROVIDERS[provider]]

const results = await Promise.all(selected.map(fetchProvider))
const render =
  mode === "compact"
    ? output === "markdown"
      ? renderCompactMarkdown
      : renderCompactTerminal
    : output === "markdown"
      ? renderFullMarkdown
      : renderFullTerminal

console.log(results.map(render).join("\n\n"))
process.exit(results.every((r) => !r.ok) ? 1 : 0)
