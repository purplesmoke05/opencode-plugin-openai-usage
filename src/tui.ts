import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"

const POLL_MS = 60_000
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

interface Credits {
  has?: boolean
  unlimited?: boolean
  balance?: string | number
}

interface Snapshot {
  plan?: string
  usedPct?: number
  resetMs?: number
  limitReached?: boolean
  credits?: Credits
}

async function readAuth(): Promise<{ access: string; accountId?: string } | null> {
  const home = process.env.HOME
  if (!home) return null
  try {
    const file = Bun.file(`${home}/.local/share/opencode/auth.json`)
    if (!(await file.exists())) return null
    const data = (await file.json()) as Record<string, { access?: unknown; accountId?: unknown }>
    const entry = data?.["openai"]
    const access = entry?.access
    if (typeof access !== "string" || access.length === 0) return null
    return {
      access,
      accountId: typeof entry?.accountId === "string" ? entry.accountId : undefined,
    }
  } catch {
    return null
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchSnapshot(auth: { access: string; accountId?: string }): Promise<Snapshot> {
  const res = await fetchWithTimeout(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
      originator: "codex_cli_rs",
      "User-Agent": "codex-cli/0.154.0",
      Accept: "application/json",
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as {
    plan_type?: unknown
    rate_limit?: {
      limit_reached?: unknown
      primary_window?: { used_percent?: unknown; reset_after_seconds?: unknown } | null
    } | null
    credits?: { has_credits?: unknown; unlimited?: unknown; balance?: unknown } | null
  }

  const primary = data?.rate_limit?.primary_window ?? null
  const used = typeof primary?.used_percent === "number" ? primary.used_percent : undefined
  return {
    plan: typeof data?.plan_type === "string" ? data.plan_type : undefined,
    usedPct: used,
    resetMs: typeof primary?.reset_after_seconds === "number" ? primary.reset_after_seconds * 1000 : undefined,
    limitReached: data?.rate_limit?.limit_reached === true,
    credits: data?.credits
      ? {
          has: data.credits.has_credits === true,
          unlimited: data.credits.unlimited === true,
          balance: typeof data.credits.balance === "string" || typeof data.credits.balance === "number"
            ? data.credits.balance
            : undefined,
        }
      : undefined,
  }
}

function fmtDelta(ms: number): string {
  const diff = Math.floor(ms / 1000)
  if (diff <= 0) return ""
  const d = Math.floor(diff / 86400)
  const h = Math.floor((diff % 86400) / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

const plugin: TuiPlugin = async (api) => {
  // Use the TUI process's own solid runtime so reactive effects integrate
  // with the host renderer (same approach as built-in sidebar sections).
  const solid = await import("@opentui/solid").catch(() => null)
  if (!solid) return
  const solidjs = await import("solid-js").catch(() => null)
  if (!solidjs || typeof solidjs.createSignal !== "function") return

  const [snap, setSnap] = solidjs.createSignal<Snapshot | null>(null)
  const [err, setErr] = solidjs.createSignal<string | null>(null)
  let disposed = false
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content() {
        return buildSidebar(solid, solidjs, api, snap, err)
      },
    },
  })

  const tick = async () => {
    if (disposed || inFlight) {
      if (!disposed) schedule()
      return
    }
    inFlight = true
    try {
      const auth = await readAuth()
      if (!auth) {
        setSnap(null)
        setErr("OpenAI OAuth credentials not found")
      } else {
        setSnap(await fetchSnapshot(auth))
        setErr(null)
      }
      api.renderer.requestRender()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const unauthorized = /\b(401|403)\b/.test(message)
      setErr(unauthorized ? "openai: unauthorized (token expired?)" : `openai: ${message}`)
      api.renderer.requestRender()
    } finally {
      inFlight = false
      if (!disposed) schedule()
    }
  }

  const schedule = () => {
    // Retry quickly while the first successful fetch is still pending (or the
    // first one failed), so the sidebar does not sit on "Loading..." or an
    // error line for a full poll interval after a transient startup failure.
    const delay = snap() === null ? (err() ? 10_000 : 5_000) : POLL_MS
    timer = setTimeout(tick, delay)
  }

  void tick()

  api.lifecycle.onDispose(() => {
    disposed = true
    if (timer) clearTimeout(timer)
  })
}

/**
 * Builds a reactive sidebar element: the child list is passed to
 * `solid.insert` as an accessor, so it re-evaluates whenever the underlying
 * signals change — updating the on-screen text even while the TUI is idle.
 */
function buildSidebar(
  solid: any,
  solidjs: any,
  api: TuiPluginApi,
  snap: () => Snapshot | null,
  err: () => string | null,
) {
  const box = solid.createElement("box")
  solid.setProp(box, "flexDirection", "column")

  const leftBar = (usedFrac: number) => {
    const leftPct = Math.max(0, Math.min(100, (1 - usedFrac) * 100))
    const size = 13
    const filled = Math.max(0, Math.min(size, Math.round((leftPct / 100) * size)))
    return `${"█".repeat(filled)}${"░".repeat(size - filled)} ${leftPct.toFixed(0)}% Left`
  }

  const children = () => {
    const s = snap()
    const e = err()
    const theme = api.theme.current
    const out: any[] = []

    const title = solid.createElement("text")
    solid.setProp(title, "fg", theme.text)
    // Title node (bold)
    const titleBox = solid.createElement("b")
    solid.insert(titleBox, "OpenAI (Codex)")
    solid.insert(title, titleBox)
    out.push(title)

    if (e) {
      const t = solid.createElement("text")
      solid.setProp(t, "fg", theme.textMuted)
      solid.insert(t, e)
      out.push(t)
      return out
    }

    if (!s) {
      const t = solid.createElement("text")
      solid.setProp(t, "fg", theme.textMuted)
      solid.insert(t, "Loading...")
      out.push(t)
      return out
    }

    if (s.usedPct === undefined) {
      const t = solid.createElement("text")
      solid.setProp(t, "fg", theme.textMuted)
      solid.insert(t, "No limits reported")
      out.push(t)
    } else {
      const t = solid.createElement("text")
      solid.setProp(t, "fg", theme.textMuted)
      const reset = s.resetMs !== undefined ? fmtDelta(s.resetMs) : ""
      solid.insert(t, `Weekly (7d) ${leftBar(s.usedPct / 100)}${reset ? ` · Resets In ${reset}` : ""}`)
      out.push(t)
    }

    if (s.limitReached) {
      const t = solid.createElement("text")
      solid.setProp(t, "fg", theme.warning)
      const reset = s.resetMs !== undefined ? ` (resets In ${fmtDelta(s.resetMs)})` : ""
      solid.insert(t, `Limit reached${reset}`)
      out.push(t)
    }

    const credits = s.credits
    const creditText = credits?.unlimited
      ? "Credits unlimited"
      : credits?.has
        ? `Credits ${credits.balance ?? "?"}`
        : `Credits ${credits?.balance ?? 0} · ${s.plan ?? "unknown"}`
    const ct = solid.createElement("text")
    solid.setProp(ct, "fg", theme.textMuted)
    solid.insert(ct, creditText)
    out.push(ct)

    return out
  }

  // Pass an accessor: solid's insert tracks the signals read inside and
  // re-runs it on change, replacing the rendered children.
  solid.insert(box, () => children())
  return box
}

export default {
  id: "openai-usage-tui",
  tui: plugin,
} as const
