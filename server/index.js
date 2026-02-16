import express from "express"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createPublicClient, http, parseAbi, parseAbiItem, recoverMessageAddress } from "viem"
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

const verifyReserveSignature = async (reserve) => {
  const signer = reserve?.signer
  const signature = reserve?.signature
  if (!signer || !signature) {
    return {
      ...reserve,
      signatureValid: null,
      recoveredSigner: null,
      signatureError: null,
    }
  }

  try {
    const recoveredSigner = await recoverMessageAddress({
      message: reserveMessage(reserve),
      signature,
    })
    const signatureValid = normalizeAddress(recoveredSigner) === normalizeAddress(signer)
    return {
      ...reserve,
      signatureValid,
      recoveredSigner,
      signatureError: null,
    }
  } catch (err) {
    return {
      ...reserve,
      signatureValid: false,
      recoveredSigner: null,
      signatureError: String(err?.message || err),
    }
  }
}

const maybeSignReserve = async (reserve) => {
  const base = reserve

  if (!reserveSigningAccount) {
    return verifyReserveSignature(base)
  }
  try {
    const signature = await reserveSigningAccount.signMessage({ message: reserveMessage(reserve) })
    const signed = {
      ...base,
      signer: reserveSigningAccount.address,
      signature,
    }
    return verifyReserveSignature(signed)
  } catch {
    return verifyReserveSignature(base)
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
    const [primaryReserve, secondaryReserve] = await Promise.all([
      maybeSignReserve(reserveFor("source-a")),
      maybeSignReserve(reserveFor("source-b")),
    ])
    const reserves = {
      primary: primaryReserve,
      secondary: secondaryReserve,
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

const consoleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./public")
const consoleIndexPath = path.join(consoleRoot, "index.html")
const legacyConsolePath = path.join(consoleRoot, "console.html")

app.get("/", (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""
  res.redirect(`/console${query}`)
})

app.get("/console", (req, res) => {
  if (fs.existsSync(consoleIndexPath)) {
    res.sendFile(consoleIndexPath)
    return
  }

  res.sendFile(legacyConsolePath)
})

app.get("/console/:projectId/status", (req, res) => {
  if (fs.existsSync(consoleIndexPath)) {
    res.sendFile(consoleIndexPath)
    return
  }

  res.sendFile(legacyConsolePath)
})

app.get("/:projectId/status", (req, res, next) => {
  const projectId = String(req.params?.projectId || "").trim()
  const reserved = new Set(["api", "admin", "reserve", "incident", "console"])
  if (!projectId || reserved.has(projectId)) {
    next()
    return
  }

  if (fs.existsSync(consoleIndexPath)) {
    res.sendFile(consoleIndexPath)
    return
  }

  res.sendFile(legacyConsolePath)
})

app.use("/console", express.static(consoleRoot))

const port = Number(process.env.PORT || 8787)
app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`reserve api listening on http://127.0.0.1:${port}\n`)
})
