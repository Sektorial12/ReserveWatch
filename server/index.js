import express from "express"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"

const app = express()
app.use(express.json())

let mode = process.env.RESERVE_MODE || "healthy"

const incidentStateByProjectId = new Map()

const getIncidentState = (projectId) => {
  const key = projectId || "default"
  const existing = incidentStateByProjectId.get(key)
  if (existing) return existing
  return {
    active: false,
    severity: "warning",
    message: "",
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

const setIncidentState = ({ projectId, active, severity, message }) => {
  const key = projectId || "default"
  const next = {
    active: Boolean(active),
    severity: severity === "critical" ? "critical" : "warning",
    message: typeof message === "string" ? message : "",
    updatedAt: Math.floor(Date.now() / 1000),
  }
  incidentStateByProjectId.set(key, next)
  return next
}

let reserveSigningAccount = null
try {
  const pk = process.env.RESERVE_SIGNING_PRIVATE_KEY
  if (pk) reserveSigningAccount = privateKeyToAccount(pk)
} catch {
  reserveSigningAccount = null
}

const reserveMessage = ({ timestamp, reserveUsd, navUsd, source }) => {
  if (navUsd !== undefined && navUsd !== null) {
    return `ReserveWatch:v2|source=${source}|reserveUsd=${reserveUsd}|navUsd=${navUsd}|timestamp=${timestamp}`
  }
  return `ReserveWatch:v1|source=${source}|reserveUsd=${reserveUsd}|timestamp=${timestamp}`
}

const maybeSignReserve = async (reserve) => {
  if (!reserveSigningAccount) return reserve
  try {
    const signature = await reserveSigningAccount.signMessage({ message: reserveMessage(reserve) })
    return {
      ...reserve,
      signer: reserveSigningAccount.address,
      signature,
    }
  } catch {
    return reserve
  }
}

const receiverAbi = parseAbi([
  "function lastAttestationHash() view returns (bytes32)",
  "function lastReserveUsd() view returns (uint256)",
  "function lastLiabilitySupply() view returns (uint256)",
  "function lastCoverageBps() view returns (uint256)",
  "function lastAsOfTimestamp() view returns (uint256)",
  "function mintingPaused() view returns (bool)",
  "function minCoverageBps() view returns (uint256)",
  "function owner() view returns (address)",
  "function getForwarderAddress() view returns (address)",
])

const receiverNavAbi = parseAbi(["function lastNavUsd() view returns (uint256)"])

const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function mintingEnabled() view returns (bool)",
  "function guardian() view returns (address)",
  "function owner() view returns (address)",
])

const receiverAttestationPublishedEvent = parseAbiItem(
  "event AttestationPublished(bytes32 indexed attestationHash, uint256 reserveUsd, uint256 liabilitySupply, uint256 coverageBps, uint256 asOfTimestamp, bool breakerTriggered)"
)

const receiverAttestationPublishedV2Event = parseAbiItem(
  "event AttestationPublishedV2(bytes32 indexed attestationHash, uint256 reserveUsd, uint256 navUsd, uint256 liabilitySupply, uint256 coverageBps, uint256 asOfTimestamp, bool breakerTriggered)"
)

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const normalizeAddress = (addr) => {
  if (!addr) return ""
  return String(addr).toLowerCase()
}

const getAttestationHistory = async ({ project, limit }) => {
  const rpcUrl = project?.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com"
  const receiverAddress = (project?.receiverAddress || "").toLowerCase()

  if (!receiverAddress) {
    return {
      rpcUrl,
      receiverAddress,
      error: "missing receiver address",
      events: [],
    }
  }

  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl, { timeout: 15_000 }),
  })

  try {
    const lookbackBlocks = Number(process.env.HISTORY_LOOKBACK_BLOCKS || 50_000)
    const toBlock = await client.getBlockNumber()
    const lb = Number.isFinite(lookbackBlocks) && lookbackBlocks > 0 ? BigInt(lookbackBlocks) : 50_000n
    const fromBlock = toBlock > lb ? toBlock - lb : 0n

    const [logsV1, logsV2] = await Promise.all([
      client.getLogs({
        address: receiverAddress,
        event: receiverAttestationPublishedEvent,
        fromBlock,
        toBlock,
      }),
      client
        .getLogs({
          address: receiverAddress,
          event: receiverAttestationPublishedV2Event,
          fromBlock,
          toBlock,
        })
        .catch(() => []),
    ])

    const items = [...logsV1, ...logsV2]
      .map((l) => {
        const args = l.args || {}
        return {
          blockNumber: l.blockNumber?.toString?.() || null,
          transactionHash: l.transactionHash || null,
          logIndex: typeof l.logIndex === "number" ? l.logIndex : l.logIndex?.toString?.() || null,
          attestationHash: args.attestationHash,
          reserveUsd: args.reserveUsd?.toString?.() || null,
          navUsd: args.navUsd?.toString?.() || null,
          liabilitySupply: args.liabilitySupply?.toString?.() || null,
          coverageBps: args.coverageBps?.toString?.() || null,
          asOfTimestamp: args.asOfTimestamp?.toString?.() || null,
          breakerTriggered: typeof args.breakerTriggered === "boolean" ? args.breakerTriggered : null,
        }
      })
      .sort((a, b) => {
        const ab = BigInt(a.blockNumber || 0)
        const bb = BigInt(b.blockNumber || 0)
        if (ab !== bb) return ab > bb ? -1 : 1
        const ai = Number(a.logIndex || 0)
        const bi = Number(b.logIndex || 0)
        return bi - ai
      })
      .slice(0, limit)

    return {
      rpcUrl,
      receiverAddress,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      events: items,
    }
  } catch (err) {
    return {
      rpcUrl,
      receiverAddress,
      error: String(err?.message || err),
      events: [],
    }
  }
}

let lastSeenMintingPaused
let lastSeenMintingEnabled

const resolveWorkflowConfigPath = () => {
  const override = process.env.RESERVEWATCH_CONFIG_PATH
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override)
  }

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, "../reservewatch-workflow/config.staging.json")
}

const loadWorkflowConfig = () => {
  const p = resolveWorkflowConfigPath()
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

const getDefaultProjectId = () => {
  const cfg = loadProjectsConfig()
  if (cfg?.defaultProjectId) return cfg.defaultProjectId
  return null
}

const resolveProjectsPath = () => {
  const override = process.env.RESERVEWATCH_PROJECTS_PATH
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override)
  }

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, "./projects.json")
}

const loadProjectsConfig = () => {
  const p = resolveProjectsPath()
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"))
    const projects = Array.isArray(raw?.projects) ? raw.projects : Array.isArray(raw) ? raw : []
    return {
      path: p,
      defaultProjectId: typeof raw?.defaultProjectId === "string" ? raw.defaultProjectId : null,
      projects,
    }
  } catch {
    return null
  }
}

const getFallbackProject = () => {
  const cfg = loadWorkflowConfig()
  return {
    id: "default",
    name: "Default (workflow config)",
    receiverAddress: process.env.RECEIVER_ADDRESS || cfg?.receiverAddress || "",
    liabilityTokenAddress: process.env.LIABILITY_TOKEN_ADDRESS || cfg?.liabilityTokenAddress || "",
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    explorerBaseUrl: process.env.EXPLORER_BASE_URL || "https://sepolia.etherscan.io",
    expectedForwarderAddress: process.env.EXPECTED_FORWARDER_ADDRESS || null,
    maxReserveAgeS: process.env.MAX_RESERVE_AGE_S ? Number(process.env.MAX_RESERVE_AGE_S) : null,
    maxReserveMismatchRatio: process.env.MAX_RESERVE_MISMATCH_RATIO ? Number(process.env.MAX_RESERVE_MISMATCH_RATIO) : null,
  }
}

const listProjects = () => {
  const cfg = loadProjectsConfig()
  const fallback = getFallbackProject()

  if (cfg?.projects?.length) {
    return cfg.projects
      .filter((p) => p && typeof p.id === "string")
      .map((p) => ({
        id: p.id,
        name: p.name || p.id,
        receiverAddress: p.receiverAddress || "",
        liabilityTokenAddress: p.liabilityTokenAddress || "",
        rpcUrl: p.rpcUrl || fallback.rpcUrl,
        explorerBaseUrl: p.explorerBaseUrl || fallback.explorerBaseUrl,
        expectedForwarderAddress: p.expectedForwarderAddress || null,
        maxReserveAgeS: Number.isFinite(Number(p.maxReserveAgeS)) ? Number(p.maxReserveAgeS) : null,
        maxReserveMismatchRatio: Number.isFinite(Number(p.maxReserveMismatchRatio)) ? Number(p.maxReserveMismatchRatio) : null,
      }))
  }

  return [fallback]
}

const getProjectById = (projectId) => {
  const all = listProjects()

  if (!projectId) {
    const defaultId = getDefaultProjectId()
    if (defaultId) {
      const foundDefault = all.find((p) => p.id === defaultId)
      if (foundDefault) return foundDefault
    }
    return all[0]
  }
  const found = all.find((p) => p.id === projectId)
  return found || all[0]
}

const maybeSendWebhook = async (payload) => {
  const url = process.env.ALERT_WEBHOOK_URL
  if (!url) return
  if (typeof fetch !== "function") return

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
  } catch {
    return
  }
}

const getOnchainStatus = async ({ project }) => {
  const rpcUrl = project?.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com"

  const receiverAddress = (project?.receiverAddress || "").toLowerCase()
  const liabilityTokenAddress = (project?.liabilityTokenAddress || "").toLowerCase()

  if (!receiverAddress || !liabilityTokenAddress) {
    return {
      rpcUrl,
      receiverAddress,
      liabilityTokenAddress,
      error: "missing receiver/token address",
    }
  }

  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl, { timeout: 15_000 }),
  })

  try {
    const [blockNumber, receiverState, tokenState] = await Promise.all([
      client.getBlockNumber(),
      Promise.all([
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "lastAttestationHash" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "lastReserveUsd" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "lastLiabilitySupply" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "lastCoverageBps" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "lastAsOfTimestamp" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "mintingPaused" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "minCoverageBps" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "owner" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "getForwarderAddress" }),
      ]),
      Promise.all([
        client.readContract({ address: liabilityTokenAddress, abi: tokenAbi, functionName: "totalSupply" }),
        client.readContract({ address: liabilityTokenAddress, abi: tokenAbi, functionName: "mintingEnabled" }),
        client.readContract({ address: liabilityTokenAddress, abi: tokenAbi, functionName: "guardian" }),
        client.readContract({ address: liabilityTokenAddress, abi: tokenAbi, functionName: "owner" }),
      ]),
    ])

    const [
      lastAttestationHash,
      lastReserveUsd,
      lastLiabilitySupply,
      lastCoverageBps,
      lastAsOfTimestamp,
      mintingPaused,
      minCoverageBps,
      receiverOwner,
      forwarderAddress,
    ] = receiverState

    let lastNavUsd = null
    try {
      lastNavUsd = await client.readContract({ address: receiverAddress, abi: receiverNavAbi, functionName: "lastNavUsd" })
    } catch {
      lastNavUsd = null
    }

    const [totalSupply, mintingEnabled, guardian, tokenOwner] = tokenState

    const nextMintingPaused = Boolean(mintingPaused)
    const nextMintingEnabled = Boolean(mintingEnabled)

    const changed =
      typeof lastSeenMintingPaused === "boolean" &&
      (lastSeenMintingPaused !== nextMintingPaused || lastSeenMintingEnabled !== nextMintingEnabled)

    lastSeenMintingPaused = nextMintingPaused
    lastSeenMintingEnabled = nextMintingEnabled

    if (changed) {
      void maybeSendWebhook({
        type: "enforcement_state_changed",
        at: Math.floor(Date.now() / 1000),
        receiverAddress,
        liabilityTokenAddress,
        mintingPaused: nextMintingPaused,
        mintingEnabled: nextMintingEnabled,
      })
    }

    const hookWired = normalizeAddress(guardian) === normalizeAddress(receiverAddress)
    const forwarderSet = normalizeAddress(forwarderAddress) !== ZERO_ADDRESS
    const expectedForwarder = project?.expectedForwarderAddress || process.env.EXPECTED_FORWARDER_ADDRESS || ""
    const forwarderMatchesExpected = expectedForwarder
      ? normalizeAddress(forwarderAddress) === normalizeAddress(expectedForwarder)
      : null

    return {
      rpcUrl,
      blockNumber: blockNumber.toString(),
      project: {
        id: project?.id || null,
        name: project?.name || null,
      },
      receiverAddress,
      liabilityTokenAddress,
      receiver: {
        lastAttestationHash,
        lastReserveUsd: lastReserveUsd.toString(),
        lastNavUsd: lastNavUsd !== null ? lastNavUsd.toString() : null,
        lastLiabilitySupply: lastLiabilitySupply.toString(),
        lastCoverageBps: lastCoverageBps.toString(),
        lastAsOfTimestamp: lastAsOfTimestamp.toString(),
        mintingPaused: nextMintingPaused,
        minCoverageBps: minCoverageBps.toString(),
        owner: receiverOwner,
        forwarderAddress,
      },
      token: {
        totalSupply: totalSupply.toString(),
        mintingEnabled: nextMintingEnabled,
        guardian,
        owner: tokenOwner,
      },
      permissions: {
        receiverOwner,
        tokenOwner,
        forwarderAddress,
        guardian,
      },
      enforcement: {
        hookWired,
        forwarderSet,
        expectedForwarder: expectedForwarder || null,
        forwarderMatchesExpected,
      },
    }
  } catch (err) {
    return {
      rpcUrl,
      receiverAddress,
      liabilityTokenAddress,
      error: String(err?.message || err),
    }
  }
}

const toFiniteNumber = (value) => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const computeDerived = ({ reserves, onchain, project, incident }) => {
  const now = Math.floor(Date.now() / 1000)

  const maxReserveAgeS =
    (project?.maxReserveAgeS ?? null) !== null && Number.isFinite(Number(project?.maxReserveAgeS))
      ? Number(project.maxReserveAgeS)
      : Number(process.env.MAX_RESERVE_AGE_S || 120)
  const maxMismatchRatio =
    (project?.maxReserveMismatchRatio ?? null) !== null && Number.isFinite(Number(project?.maxReserveMismatchRatio))
      ? Number(project.maxReserveMismatchRatio)
      : Number(process.env.MAX_RESERVE_MISMATCH_RATIO || 0.01)

  const primaryAgeS = reserves?.primary?.timestamp ? now - reserves.primary.timestamp : null
  const secondaryAgeS = reserves?.secondary?.timestamp ? now - reserves.secondary.timestamp : null
  const reserveStale =
    (typeof primaryAgeS === "number" && primaryAgeS > maxReserveAgeS) ||
    (typeof secondaryAgeS === "number" && secondaryAgeS > maxReserveAgeS)

  const primaryReserveUsd = toFiniteNumber(reserves?.primary?.reserveUsd)
  const secondaryReserveUsd = toFiniteNumber(reserves?.secondary?.reserveUsd)
  let reserveMismatchUsd = null
  let reserveMismatchRatio = null
  let sourceMismatch = false

  if (typeof primaryReserveUsd === "number" && typeof secondaryReserveUsd === "number") {
    reserveMismatchUsd = Math.abs(primaryReserveUsd - secondaryReserveUsd)
    const denom = Math.max(primaryReserveUsd, secondaryReserveUsd, 1)
    reserveMismatchRatio = reserveMismatchUsd / denom
    sourceMismatch = reserveMismatchRatio > maxMismatchRatio
  }

  const coverageBps = toFiniteNumber(onchain?.receiver?.lastCoverageBps)
  const minCoverageBps = toFiniteNumber(onchain?.receiver?.minCoverageBps)
  const mintingPaused = onchain?.receiver?.mintingPaused
  const mintingEnabled = onchain?.token?.mintingEnabled
  const enforcementHookWired = Boolean(onchain?.enforcement?.hookWired)
  const forwarderSet = Boolean(onchain?.enforcement?.forwarderSet)

  const reasons = []
  if (onchain?.error) reasons.push("onchain_unavailable")
  if (reserveStale) reasons.push("reserve_data_stale")
  if (sourceMismatch) reasons.push("reserve_source_mismatch")
  if (incident?.active) reasons.push("incident_active")
  if (!enforcementHookWired) reasons.push("enforcement_not_wired")
  if (!forwarderSet) reasons.push("forwarder_not_set")
  if (mintingPaused === true) reasons.push("minting_paused")
  if (mintingEnabled === false) reasons.push("minting_disabled")
  if (Number.isFinite(coverageBps) && Number.isFinite(minCoverageBps) && coverageBps < minCoverageBps) {
    reasons.push("coverage_below_threshold")
  }

  let status = "HEALTHY"
  if (onchain?.error || reserveStale) status = "STALE"
  else if (sourceMismatch) status = "DEGRADED"
  else if (incident?.active) status = incident?.severity === "critical" ? "UNHEALTHY" : "DEGRADED"
  else if (!enforcementHookWired) status = "DEGRADED"
  else if (!forwarderSet) status = "DEGRADED"
  else if (reasons.includes("coverage_below_threshold") || reasons.includes("minting_paused") || reasons.includes("minting_disabled")) {
    status = "UNHEALTHY"
  }

  return {
    now,
    maxReserveAgeS,
    maxMismatchRatio,
    reserveAgesS: {
      primary: primaryAgeS,
      secondary: secondaryAgeS,
    },
    reserveStale,
    sourceMismatch,
    reserveMismatchUsd,
    reserveMismatchRatio,
    coverageBps,
    minCoverageBps,
    enforcementHookWired,
    forwarderSet,
    mintingPaused,
    mintingEnabled,
    incident,
    status,
    reasons,
  }
}

const reserveFor = (source) => {
  const now = Math.floor(Date.now() / 1000)

  if (mode === "unhealthy") {
    return {
      timestamp: now,
      reserveUsd: "900000",
      navUsd: "880000",
      source,
    }
  }

  return {
    timestamp: now,
    reserveUsd: "1200000",
    navUsd: "1195000",
    source,
  }
}

app.get("/reserve/source-a", async (req, res) => {
  res.json(await maybeSignReserve(reserveFor("source-a")))
})

app.get("/reserve/source-b", async (req, res) => {
  res.json(await maybeSignReserve(reserveFor("source-b")))
})

app.post("/admin/mode", (req, res) => {
  const next = req.body?.mode
  if (next !== "healthy" && next !== "unhealthy") {
    res.status(400).json({ error: "mode must be healthy|unhealthy" })
    return
  }

  mode = next
  res.json({ mode })
})

app.post("/admin/incident", (req, res) => {
  const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : null
  const active = typeof req.body?.active === "boolean" ? req.body.active : null
  const severity = typeof req.body?.severity === "string" ? req.body.severity : "warning"
  const message = typeof req.body?.message === "string" ? req.body.message : ""

  if (active === null) {
    res.status(400).json({ error: "active must be boolean" })
    return
  }

  const state = setIncidentState({ projectId, active, severity, message })
  res.json({ projectId: projectId || "default", incident: state })
})

app.get("/incident/feed", (req, res) => {
  const projectId = typeof req.query?.project === "string" ? req.query.project : null
  res.json({ projectId: projectId || "default", incident: getIncidentState(projectId) })
})

app.get("/api/projects", (req, res) => {
  const defaultProjectId = getDefaultProjectId()
  const projects = listProjects().map((p) => ({ id: p.id, name: p.name }))
  res.json({ defaultProjectId, projects })
})

app.get("/api/status", async (req, res) => {
  try {
    const projectId = typeof req.query?.project === "string" ? req.query.project : null
    const project = getProjectById(projectId)

    const incident = getIncidentState(project?.id)

    const onchain = await getOnchainStatus({ project })
    const reserves = {
      primary: reserveFor("source-a"),
      secondary: reserveFor("source-b"),
    }

    const derived = computeDerived({ reserves, onchain, project, incident })
    const explorerBase = project?.explorerBaseUrl || "https://sepolia.etherscan.io"
    const receiverAddress = onchain?.receiverAddress
    const liabilityTokenAddress = onchain?.liabilityTokenAddress
    const guardian = onchain?.token?.guardian
    const receiverOwner = onchain?.receiver?.owner
    const tokenOwner = onchain?.token?.owner
    const forwarderAddress = onchain?.receiver?.forwarderAddress

    const links = {
      explorerBase,
      receiver: receiverAddress ? `${explorerBase}/address/${receiverAddress}` : null,
      token: liabilityTokenAddress ? `${explorerBase}/address/${liabilityTokenAddress}` : null,
      guardian: guardian ? `${explorerBase}/address/${guardian}` : null,
      receiverOwner: receiverOwner ? `${explorerBase}/address/${receiverOwner}` : null,
      tokenOwner: tokenOwner ? `${explorerBase}/address/${tokenOwner}` : null,
      forwarder: forwarderAddress ? `${explorerBase}/address/${forwarderAddress}` : null,
      lastTx: process.env.LAST_BROADCAST_TX ? `${explorerBase}/tx/${process.env.LAST_BROADCAST_TX}` : null,
    }

    const interfaces = {
      enforcementHook: {
        contract: "LiabilityToken",
        function: "setMintingEnabled(bool)",
        authorizedCallers: ["guardian", "owner"],
      },
      policy: {
        contract: "ReserveWatchReceiver",
        function: "setMinCoverageBps(uint256)",
        authorizedCallers: ["owner"],
      },
      reportReceiver: {
        contract: "ReserveWatchReceiver",
        function: "onReport(bytes metadata, bytes report)",
        authorizedCallers: ["forwarder"],
      },
    }

    const operator = {
      recommendedActions: [],
      flows: {
        reenableMinting: {
          guarded: true,
          how: "broadcast_healthy_attestation",
          steps: [
            "Fix underlying issue (reserves restored, data sources healthy)",
            "Set reserve API to healthy (demo) or validate live sources (prod)",
            "Run workflow with broadcast to publish a healthy attestation",
            "Verify onchain: receiver.mintingPaused=false AND token.mintingEnabled=true",
          ],
          notes: [
            "Directly calling token.setMintingEnabled(true) should be restricted to owner/guardian; the preferred path is a healthy attestation to avoid bypassing policy.",
          ],
        },
      },
    }

    if (derived.status === "STALE") {
      operator.recommendedActions.push("check_rpc_and_data_sources")
    }
    if (derived.reasons.includes("enforcement_not_wired") || derived.reasons.includes("forwarder_not_set")) {
      operator.recommendedActions.push("fix_enforcement_wiring_roles")
    }
    if (derived.reasons.includes("reserve_source_mismatch")) {
      operator.recommendedActions.push("investigate_source_discrepancy")
    }
    if (derived.reasons.includes("incident_active")) {
      operator.recommendedActions.push("check_incident_feed")
    }
    if (derived.reasons.includes("coverage_below_threshold")) {
      operator.recommendedActions.push("broadcast_new_attestation_after_fix")
    }
    if (derived.reasons.includes("minting_paused") || derived.reasons.includes("minting_disabled")) {
      operator.recommendedActions.push("use_guarded_reenable_flow")
    }

    res.json({ mode, reserves, onchain, incident, derived, links, interfaces, operator })
  } catch (err) {
    res.status(500).json({
      mode,
      error: String(err?.message || err),
    })
  }
})

app.get("/api/history", async (req, res) => {
  try {
    const projectId = typeof req.query?.project === "string" ? req.query.project : null
    const project = getProjectById(projectId)
    const limitRaw = typeof req.query?.limit === "string" ? Number(req.query.limit) : 10
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 10

    const history = await getAttestationHistory({ project, limit })
    const explorerBase = project?.explorerBaseUrl || "https://sepolia.etherscan.io"
    const events = Array.isArray(history?.events)
      ? history.events.map((e) => ({
          ...e,
          txUrl: e?.transactionHash ? `${explorerBase}/tx/${e.transactionHash}` : null,
        }))
      : []

    res.json({
      project: { id: project?.id || null, name: project?.name || null },
      receiverAddress: history?.receiverAddress || null,
      rpcUrl: history?.rpcUrl || null,
      fromBlock: history?.fromBlock || null,
      toBlock: history?.toBlock || null,
      error: history?.error || null,
      events,
    })
  } catch (err) {
    res.status(500).json({
      error: String(err?.message || err),
    })
  }
})

app.get(["/", "/console"], (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>ReserveWatch Console</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; padding: 18px; }
      .wrap { max-width: 1100px; margin: 0 auto; }
      h1 { margin: 0 0 6px 0; font-size: 20px; }
      .sub { opacity: 0.7; margin-bottom: 12px; }
      .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0 14px; }
      button { padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(127,127,127,0.35); background: transparent; cursor: pointer; }
      pre { margin: 0; padding: 12px; border-radius: 12px; border: 1px solid rgba(127,127,127,0.25); overflow: auto; }
      .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.35); font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>ReserveWatch Console</h1>
      <div class="sub">Polling <code>/api/status</code> (placeholder UI — your teammate can replace)</div>
      <div class="row">
        <label class="pill">project <select id="project"></select></label>
        <span class="pill" id="health">loading...</span>
        <span class="pill" id="incident"></span>
        <span class="pill" id="metrics"></span>
        <span class="pill" id="enforcement"></span>
        <span class="pill" id="updated"></span>
      </div>
      <div class="row">
        <span class="pill" id="reasons"></span>
      </div>
      <div class="row">
        <button id="btnHealthy">Set reserve API: healthy</button>
        <button id="btnUnhealthy">Set reserve API: unhealthy</button>
        <button id="btnRefresh">Refresh</button>
      </div>
      <div class="row" id="links"></div>
      <pre id="history"></pre>
      <pre id="json"></pre>
    </div>

    <script>
      const el = (id) => document.getElementById(id)

      const fetchJson = async (url, { timeoutMs = 8000, retries = 1 } = {}) => {
        let lastErr
        for (let attempt = 0; attempt <= retries; attempt++) {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), timeoutMs)
          try {
            const r = await fetch(url, { signal: controller.signal })
            if (!r.ok) {
              const t = await r.text().catch(() => '')
              throw new Error('HTTP ' + r.status + (t ? (' ' + t) : ''))
            }
            return await r.json()
          } catch (err) {
            lastErr = err
            if (attempt === retries) throw err
          } finally {
            clearTimeout(timeout)
          }
        }
        throw lastErr || new Error('fetch failed')
      }

      const getProjectFromUrl = () => {
        const u = new URL(window.location.href)
        return u.searchParams.get('project')
      }

      const setProjectInUrl = (projectId) => {
        const u = new URL(window.location.href)
        if (projectId) u.searchParams.set('project', projectId)
        else u.searchParams.delete('project')
        window.history.replaceState({}, '', u.toString())
      }

      const loadProjects = async () => {
        const sel = el('project')
        try {
          const j = await fetchJson('/api/projects', { timeoutMs: 6000, retries: 1 })
          const projects = Array.isArray(j?.projects) ? j.projects : []
          const defaultProjectId = typeof j?.defaultProjectId === 'string' ? j.defaultProjectId : null
          const current = getProjectFromUrl()
          sel.innerHTML = projects.map((p) => {
            const id = String(p.id)
            const name = String(p.name || p.id)
            const selected = current === id ? ' selected' : ''
            return '<option value="' + id.replaceAll('"', '%22') + '"' + selected + '>' + name + '</option>'
          }).join('')
          if (!current) {
            if (defaultProjectId && projects.some((p) => p?.id === defaultProjectId)) setProjectInUrl(defaultProjectId)
            else if (projects[0]?.id) setProjectInUrl(projects[0].id)
          }
        } catch {
          sel.innerHTML = '<option value="">(projects unavailable)</option>'
        }
      }

      const setMode = async (mode) => {
        await fetch('/admin/mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
        await refresh()
      }

      const refresh = async () => {
        const t0 = Date.now()
        const project = getProjectFromUrl()
        let j
        try {
          j = await fetchJson('/api/status' + (project ? ('?project=' + encodeURIComponent(project)) : ''), { timeoutMs: 12_000, retries: 1 })
        } catch (err) {
          el('health').textContent = 'ERROR'
          el('enforcement').textContent = ''
          el('updated').textContent = 'error'
          el('reasons').textContent = String(err?.message || err)
          el('links').innerHTML = ''
          el('history').textContent = ''
          el('json').textContent = JSON.stringify({ error: String(err?.message || err) }, null, 2)
          return
        }

        const links = j?.links || {}
        let historyLastTxUrl = null

        try {
          const hj = await fetchJson('/api/history' + (project ? ('?project=' + encodeURIComponent(project) + '&limit=10') : '?limit=10'), { timeoutMs: 12_000, retries: 0 })
          const events = Array.isArray(hj?.events) ? hj.events : []
          historyLastTxUrl = events[0]?.txUrl || null
          const lines = events.map((e) => {
            const ts = e?.asOfTimestamp ? ('asOf=' + e.asOfTimestamp) : ''
            const nav = e?.navUsd ? ('navUsd=' + e.navUsd) : ''
            const cov = e?.coverageBps ? ('coverageBps=' + e.coverageBps) : ''
            const br = e?.breakerTriggered === true ? 'breaker=true' : (e?.breakerTriggered === false ? 'breaker=false' : '')
            const tx = e?.txUrl ? e.txUrl : (e?.transactionHash || '')
            return [ts, nav, cov, br, tx].filter(Boolean).join(' ')
          })
          el('history').textContent = lines.length ? lines.join('\n') : ''
        } catch {
          el('history').textContent = 'history unavailable'
        }

        const paused = j?.onchain?.receiver?.mintingPaused
        const enabled = j?.onchain?.token?.mintingEnabled
        const coverage = Number(j?.onchain?.receiver?.lastCoverageBps || NaN)
        const min = Number(j?.onchain?.receiver?.minCoverageBps || NaN)
        const stale = Boolean(j?.onchain?.error)
        const reasons = Array.isArray(j?.derived?.reasons) ? j.derived.reasons : []
        const incident = j?.incident || null
        const reserveUsd = j?.reserves?.primary?.reserveUsd
        const navUsd = j?.reserves?.primary?.navUsd

        let badge = 'HEALTHY'
        if (typeof j?.derived?.status === 'string') badge = j.derived.status
        else if (stale) badge = 'STALE'
        else if (paused === true || (Number.isFinite(coverage) && Number.isFinite(min) && coverage < min)) badge = 'UNHEALTHY'

        el('health').textContent = badge
        if (incident?.active) el('incident').textContent = 'incident=' + (incident?.severity || 'warning')
        else el('incident').textContent = ''
        el('metrics').textContent = 'reserveUsd=' + String(reserveUsd ?? '') + ' navUsd=' + String(navUsd ?? '')
        el('enforcement').textContent = 'mintingPaused=' + paused + ' mintingEnabled=' + enabled
        el('updated').textContent = 'updated ' + (Math.round((Date.now() - t0) / 10) / 100) + 's ago'
        el('reasons').textContent = reasons.length ? ('reasons=' + reasons.join(',')) : ''

        if (!links.lastTx && historyLastTxUrl) links.lastTx = historyLastTxUrl
        const linkItems = [
          ['receiver', links.receiver],
          ['token', links.token],
          ['guardian', links.guardian],
          ['receiverOwner', links.receiverOwner],
          ['tokenOwner', links.tokenOwner],
          ['forwarder', links.forwarder],
          ['lastTx', links.lastTx],
        ].filter(([, u]) => typeof u === 'string' && u.length)

        el('links').innerHTML = linkItems.map(([label, url]) => {
          const safe = String(url).replaceAll('"', '%22')
          return '<a href="' + safe + '" target="_blank" rel="noreferrer">' + label + '</a>'
        }).join(' ')

        el('json').textContent = JSON.stringify(j, null, 2)
      }

      el('btnHealthy').onclick = () => setMode('healthy')
      el('btnUnhealthy').onclick = () => setMode('unhealthy')
      el('btnRefresh').onclick = () => refresh()
      el('project').onchange = () => {
        setProjectInUrl(el('project').value)
        refresh()
      }

      loadProjects().then(refresh)
      setInterval(refresh, 8000)
    </script>
  </body>
</html>`)
})

const port = Number(process.env.PORT || 8787)
app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`reserve api listening on http://127.0.0.1:${port}\n`)
})
