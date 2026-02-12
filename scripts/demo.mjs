import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fetchWithTimeout = async (input, init, timeoutMs) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

const requestJson = async ({ url, method, body, timeoutMs }) => {
  const r = await fetchWithTimeout(
    url,
    {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    },
    timeoutMs
  )
  if (!r.ok) {
    const t = await r.text().catch(() => "")
    throw new Error(`HTTP ${r.status} ${t}`)
  }
  return r.json()
}

const parseArgs = (argv) => {
  const out = {
    workflow: "reservewatch-workflow",
    target: "staging-settings",
    envFile: ".env",
    broadcast: false,
    reserveApiBase: "http://127.0.0.1:8787",
    project: null,
    timeoutS: 90,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--broadcast") out.broadcast = true
    else if (a === "--no-broadcast") out.broadcast = false
    else if (a === "--workflow") out.workflow = argv[++i]
    else if (a === "--target") out.target = argv[++i]
    else if (a === "--env") out.envFile = argv[++i]
    else if (a === "--api") out.reserveApiBase = argv[++i]
    else if (a === "--project") out.project = argv[++i]
    else if (a === "--timeout") out.timeoutS = Number(argv[++i])
    else if (a === "-h" || a === "--help") {
      out.help = true
    } else {
      out.unknown = out.unknown || []
      out.unknown.push(a)
    }
  }

  return out
}

const usage = () => {
  process.stdout.write(`ReserveWatch demo runner

Usage:
  node scripts/demo.mjs [--broadcast] [--env .env] [--target staging-settings] [--workflow reservewatch-workflow]
                      [--api http://127.0.0.1:8787] [--project <id>] [--timeout 90]

Notes:
  - Without --broadcast, this will run simulations but will NOT change onchain state.
  - This script expects the reserve API server to be running and reachable at --api.
`)
}

const run = async (cmd, args, { cwd }) => {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

const toUrl = (base, pathname) => {
  const u = new URL(base)
  u.pathname = pathname
  return u.toString()
}

const setReserveMode = async (base, mode) => {
  try {
    await requestJson({
      url: toUrl(base, "/admin/mode"),
      method: "POST",
      body: { mode },
      timeoutMs: 10_000,
    })
  } catch (err) {
    throw new Error(`failed to set mode=${mode}: ${String(err?.message || err)}`)
  }
}

const getStatus = async (base, project) => {
  const u = new URL(toUrl(base, "/api/status"))
  if (project) u.searchParams.set("project", project)

  try {
    return await requestJson({
      url: u,
      method: "GET",
      body: null,
      timeoutMs: 10_000,
    })
  } catch (err) {
    const details = String(err?.message || err)
    const cause = err?.cause ? ` cause=${String(err.cause)}` : ""
    throw new Error(`failed to fetch status: ${details}${cause}`)
  }
}

const waitFor = async ({ timeoutMs, intervalMs, fn }) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fn()
    if (res?.done) return res
    await sleep(intervalMs)
  }
  throw new Error("timeout waiting for condition")
}

const waitForApiReady = async ({ base, project, timeoutMs }) => {
  await waitFor({
    timeoutMs,
    intervalMs: 1000,
    fn: async () => {
      try {
        await getStatus(base, project)
        return { done: true }
      } catch {
        return { done: false }
      }
    },
  })
}

const main = async () => {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    usage()
    process.exit(0)
  }
  if (opts.unknown?.length) {
    process.stderr.write(`unknown args: ${opts.unknown.join(" ")}` + "\n")
    usage()
    process.exit(2)
  }

  if (!Number.isFinite(opts.timeoutS) || opts.timeoutS <= 0) {
    throw new Error("--timeout must be a positive number")
  }

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const reservewatchDir = path.resolve(__dirname, "..")

  const envPath = path.isAbsolute(opts.envFile) ? opts.envFile : path.resolve(reservewatchDir, opts.envFile)
  if (!fs.existsSync(envPath)) {
    process.stderr.write(`warning: env file not found at ${envPath} (continuing)\n`)
  }

  process.stdout.write(`reserve api: ${opts.reserveApiBase}\n`)
  process.stdout.write(`project: ${opts.project || "(default)"}\n`)
  process.stdout.write(`broadcast: ${opts.broadcast}\n\n`)

  process.stdout.write("waiting for reserve API...\n")
  await waitForApiReady({
    base: opts.reserveApiBase,
    project: opts.project,
    timeoutMs: Math.min(opts.timeoutS * 1000, 30_000),
  })

  const creArgsBase = ["workflow", "simulate", opts.workflow, "--target", opts.target]
  if (opts.broadcast) creArgsBase.push("--broadcast")
  if (opts.envFile) creArgsBase.push("--env", envPath)

  process.stdout.write("=== step 1: healthy ===\n")
  await setReserveMode(opts.reserveApiBase, "healthy")
  await run("cre", creArgsBase, { cwd: reservewatchDir })

  if (opts.broadcast) {
    process.stdout.write("waiting for onchain to reflect healthy...\n")
    await waitFor({
      timeoutMs: opts.timeoutS * 1000,
      intervalMs: 4000,
      fn: async () => {
        const s = await getStatus(opts.reserveApiBase, opts.project)
        const paused = s?.onchain?.receiver?.mintingPaused
        const enabled = s?.onchain?.token?.mintingEnabled
        const ok = paused === false && enabled === true
        return { done: ok, status: s }
      },
    })
  } else {
    process.stdout.write("skipping onchain verification (run with --broadcast to verify)\n")
  }

  process.stdout.write("\n=== step 2: unhealthy ===\n")
  await setReserveMode(opts.reserveApiBase, "unhealthy")
  await run("cre", creArgsBase, { cwd: reservewatchDir })

  if (opts.broadcast) {
    process.stdout.write("waiting for onchain to reflect unhealthy...\n")
    const res = await waitFor({
      timeoutMs: opts.timeoutS * 1000,
      intervalMs: 4000,
      fn: async () => {
        const s = await getStatus(opts.reserveApiBase, opts.project)
        const paused = s?.onchain?.receiver?.mintingPaused
        const enabled = s?.onchain?.token?.mintingEnabled
        const ok = paused === true && enabled === false
        return { done: ok, status: s }
      },
    })

    const final = res.status
    process.stdout.write("\nfinal onchain:\n")
    process.stdout.write(JSON.stringify({
      receiver: final?.onchain?.receiver,
      token: final?.onchain?.token,
      derived: final?.derived,
      links: final?.links,
    }, null, 2) + "\n")
  } else {
    process.stdout.write("skipping onchain verification (run with --broadcast to verify)\n")
  }

  process.stdout.write("\ndone\n")
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err) + "\n")
  process.exit(1)
})
