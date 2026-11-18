import { homedir } from "node:os"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

const APP = "opencode"
const USE_APP_ICON = true
const SUPPRESS_WHEN_TERMINAL_FOCUSED = true
const DEDUPE_WINDOW_MS = 3000

// Matched case-insensitively against the focused window's class / app_id.
// `caelestia-term` is kept for Caelestia shell; niri (Noctalia), Hyprland,
// sway and plain X11 terminals work through their own identifiers too.
const TERMINAL_IDS = [
  "kitty",
  "org.kitty.kitty",
  "alacritty",
  "foot",
  "footclient",
  "wezterm",
  "org.wezfurlong.wezterm",
  "ghostty",
  "com.mitchellh.ghostty",
  "st",
  "st-256color",
  "konsole",
  "xterm",
  "xterm-256color",
  "caelestia-term",
  "noctalia-term",
]

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#131010"/>
<path d="M320 224V352H192V224H320Z" fill="#5A5858"/>
<path fill-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="#FFFFFF"/>
</svg>`

const DATA_HOME = process.env.XDG_DATA_HOME || `${homedir()}/.local/share`
const CACHE_HOME = process.env.XDG_CACHE_HOME || `${homedir()}/.cache`
const ICON_THEME_DIR = `${DATA_HOME}/icons/hicolor/scalable/apps`
const ICON_CACHE_DIR = `${CACHE_HOME}/opencode-caelestia-notify`
const ICON_FALLBACK = `${ICON_CACHE_DIR}/${APP}.svg`

// Plain file append: no shell, so log text is never re-expanded by `sh -c`.
const debugLog = async (line) => {
  const file = process.env.OPENCODE_NOTIFY_DEBUG
  if (!file) return
  try {
    await appendFile(file, `${new Date().toISOString()} ${line}\n`, "utf8")
  } catch {
    /* logging must never break notifications */
  }
}

const readJson = async (command, args) => {
  const { stdout } = await run(command, args, {
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(stdout.trim() || "null")
}

// Each provider returns { id, title }, null when its compositor is running
// but has no focused window, or throws when unavailable (try the next one).
// Hyprland is first so Caelestia keeps its original behaviour; niri and sway
// make the same plugin work everywhere else.
const hyprlandFocus = async () => {
  const win = await readJson("hyprctl", ["-j", "activewindow"])
  if (win === null || typeof win !== "object") return null
  return { id: win.class || "", title: win.title || "" }
}

const niriFocus = async () => {
  const win = await readJson("niri", ["msg", "--json", "focused-window"])
  if (win === null) return null
  return { id: win.app_id || "", title: win.title || "" }
}

const swayFocus = async () => {
  const tree = await readJson("swaymsg", ["-t", "get_tree"])
  const findFocused = (node) => {
    if (!node) return null
    if (node.focused && node.type === "con") return node
    for (const child of node.nodes || []) {
      const found = findFocused(child)
      if (found) return found
    }
    return null
  }
  const win = findFocused(tree)
  if (!win) return null
  return {
    id: win.app_id || win.window_properties?.class || "",
    title: win.name || "",
  }
}

const FOCUS_PROVIDERS = [hyprlandFocus, niriFocus, swayFocus]

const focusedTerminal = async () => {
  if (!SUPPRESS_WHEN_TERMINAL_FOCUSED) return false
  if (process.env.OPENCODE_NOTIFY_NO_SUPPRESS === "1") return false

  for (const provider of FOCUS_PROVIDERS) {
    let win
    try {
      win = await provider()
    } catch {
      continue // compositor not running / command missing
    }
    if (win === null) return false
    const id = (win.id || "").toLowerCase()
    if (!id) return false
    return TERMINAL_IDS.some((candidate) => id === candidate.toLowerCase())
  }
  return false
}

const installIcon = async () => {
  if (!USE_APP_ICON) return null
  try {
    await mkdir(ICON_THEME_DIR, { recursive: true })
    await writeFile(`${ICON_THEME_DIR}/${APP}.svg`, ICON_SVG, "utf8")
    // Best effort only: some GTK-based notification daemons use the index.
    try {
      await run("gtk-update-icon-cache", [
        "-f",
        "-t",
        `${DATA_HOME}/icons/hicolor`,
      ])
    } catch {
      /* optional */
    }
    await mkdir(ICON_CACHE_DIR, { recursive: true })
    await writeFile(ICON_FALLBACK, ICON_SVG, "utf8")
    return APP
  } catch {
    try {
      await mkdir(ICON_CACHE_DIR, { recursive: true })
      await writeFile(ICON_FALLBACK, ICON_SVG, "utf8")
      return ICON_FALLBACK
    } catch {
      return null
    }
  }
}

// Shared event logic for both V1 (`event` hook) and V2 (`event.subscribe`).
const createEngine = async ({ directory, getSession }) => {
  const seenPermissions = new Set()
  const seenForms = new Set()
  const recent = new Map()
  const appIcon = await installIcon()
  if (!appIcon)
    await debugLog("icon install failed, using symbolic fallback")

  const isDuplicate = (key) => {
    if (!key) return false
    const now = Date.now()
    if (now - (recent.get(key) || 0) < DEDUPE_WINDOW_MS) return true
    recent.set(key, now)
    if (recent.size > 100) recent.delete(recent.keys().next().value)
    return false
  }

  const titleFor = async (sessionID) =>
    (await getSession(sessionID)) ||
    directory?.split("/").pop() ||
    "Task"

  const notify = async ({
    key,
    title,
    body,
    urgency = "normal",
    icon = "dialog-information-symbolic",
  }) => {
    if (isDuplicate(key)) {
      await debugLog(`suppressed (duplicate) ${title} | ${body}`)
      return
    }
    const args = [
      "-u",
      urgency,
      "-a",
      APP,
      "-i",
      appIcon || icon,
      "-h",
      `string:x-canonical-private-synchronous:${APP}`,
      title,
      body,
    ]
    try {
      await run("notify-send", args, { timeout: 5000 })
    } catch (err) {
      await debugLog(`notify-send failed: ${err?.message || err}`)
    }
    await debugLog(`[${urgency}] icon=${appIcon || icon} ${title} | ${body}`)
  }

  const handle = async (event) => {
    // V2 events use `data`; V1 used `properties`. Accept both so one file
    // keeps working across OpenCode versions.
    const props = event.data ?? event.properties ?? {}
    const sessionID = props.sessionID

    switch (event.type) {
      case "session.idle": {
        if (await focusedTerminal()) {
          await debugLog("suppressed (terminal focused)")
          break
        }
        await notify({
          key: `idle:${sessionID}`,
          title: `${APP}: ready`,
          body: await titleFor(sessionID),
          icon: "dialog-information-symbolic",
        })
        break
      }

      // V2 renamed session.error -> session.execution.failed.
      case "session.execution.failed":
      case "session.error": {
        const err = props.error || {}
        const detail =
          err?.data?.message ||
          err?.message ||
          err?.response?.body ||
          err?.type ||
          err?.name ||
          "Something went wrong"
        await notify({
          key: `error:${sessionID}`,
          title: `${APP}: error`,
          body: `${await titleFor(sessionID)}\n${String(detail).slice(0, 300)}`,
          urgency: "critical",
          icon: "dialog-error-symbolic",
        })
        break
      }

      case "permission.asked":
      case "permission.updated": {
        const id =
          props.permissionID ||
          props.id ||
          props.requestID ||
          props.title ||
          ""
        const key = `${sessionID}:${id}`
        if (seenPermissions.has(key)) break
        seenPermissions.add(key)
        if (seenPermissions.size > 100)
          seenPermissions.delete(seenPermissions.keys().next().value)

        const what =
          props.message ||
          props.action ||
          props.title ||
          props.type ||
          "Permission needed"
        const resources = Array.isArray(props.resources)
          ? props.resources.slice(0, 2).join(", ")
          : ""
        await notify({
          key: `perm:${key}`,
          title: `${APP}: waiting for you`,
          body: `${what}${resources ? `\n${resources}` : ""}\n${await titleFor(sessionID)}`,
          urgency: "critical",
          icon: "dialog-password-symbolic",
        })
        break
      }

      // V2 replaced question.asked with form.created.
      case "form.created":
      case "question.asked": {
        const form = props.form || {}
        const formID = form.id || props.id || ""
        const formSessionID = form.sessionID || sessionID
        if (formID && seenForms.has(formID)) break
        if (formID) {
          seenForms.add(formID)
          if (seenForms.size > 100)
            seenForms.delete(seenForms.keys().next().value)
        }
        const question =
          form.title ||
          (typeof props.question === "string" ? props.question : null) ||
          props.question?.question ||
          "OpenCode has a question"
        await notify({
          key: `question:${formID || formSessionID}`,
          title: `${APP}: question for you`,
          body: `${String(question).slice(0, 200)}\n${await titleFor(formSessionID)}`,
          urgency: "critical",
          icon: "dialog-question-symbolic",
        })
        break
      }
    }
  }

  return { handle }
}

const plugin = {
  id: "opencode-notify",

  // OpenCode v2: subscribe to the server event stream.
  async setup(ctx) {
    if (!ctx || typeof ctx.event?.subscribe !== "function") return () => {}
    const engine = await createEngine({
      directory: ctx.location?.directory,
      getSession: async (sessionID) => {
        const res = await ctx.session.get({ sessionID })
        return res?.title ?? res?.data?.title ?? null
      },
    })
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break
        try {
          await engine.handle(event)
        } catch (err) {
          await debugLog(`event handler failed: ${err?.message || err}`)
        }
      }
    })().catch((err) => {
      if (!controller.signal.aborted)
        console.warn(
          "[opencode-notify] event subscription failed:",
          err?.message || err,
        )
    })
    return () => controller.abort()
  },

  // OpenCode v1: keep the original event hook for older installs.
  async server({ client, directory }) {
    const engine = await createEngine({
      directory,
      getSession: async (sessionID) => {
        const res = await client.session.get({ path: { id: sessionID } })
        return res?.data?.title || res?.title || null
      },
    })
    return {
      event: async ({ event }) => {
        try {
          await engine.handle(event)
        } catch (err) {
          await debugLog(`event handler failed: ${err?.message || err}`)
        }
      },
    }
  },
}

export default plugin
