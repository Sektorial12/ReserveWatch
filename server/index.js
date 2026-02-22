import express from "express"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createPublicClient, http, isAddress, parseAbi, parseAbiItem, recoverMessageAddress } from "viem"
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

let activeRun = null
const runsById = new Map()

const serverRoot = path.dirname(fileURLToPath(import.meta.url))
const reservewatchRoot = path.resolve(serverRoot, "..")

const defaultEnvPath = path.resolve(reservewatchRoot, ".env")

const adminKey = String(process.env.RESERVEWATCH_ADMIN_KEY || "").trim()

const readAdminKey = (req) => {
  const headerKey = String(req.get("x-admin-key") || "").trim()
  if (headerKey) return headerKey

  const auth = String(req.get("authorization") || "").trim()
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (match) return match[1].trim()

  return ""
}

const requireAdmin = (req, res, next) => {
  if (!adminKey) return next()
  const provided = readAdminKey(req)
  if (provided !== adminKey) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  next()
}

const createRunId = () => {
  const rand = Math.random().toString(16).slice(2, 10)
  return `${Date.now().toString(16)}-${rand}`
}

const appendRunOutput = (run, chunk) => {
  const text = String(chunk || "")
  if (!text) return
  run.output = (run.output || "") + text
  const max = 120_000
  if (run.output.length > max) {
    run.output = run.output.slice(run.output.length - max)
  }
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

const normalizeId = (value) => String(value || "").trim()

const normalizeConnectorId = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
}

const numberOrNull = (value) => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/
const CONNECTOR_ID_RE = PROJECT_ID_RE

const parseOptionalNumber = (value, label, { min = null } = {}) => {
  if (value === null || value === undefined || String(value).trim() === "") {
    return { value: null, error: "" }
  }
  const n = Number(value)
  if (!Number.isFinite(n)) {
    return { value: null, error: `${label} must be a number` }
  }
  if (min !== null && n < min) {
    return { value: null, error: `${label} must be >= ${min}` }
  }
  return { value: n, error: "" }
}

const normalizeProjectPayload = (payload, { requireId = true } = {}) => {
  if (!payload || typeof payload !== "object") {
    return { error: "project payload is required", value: null }
  }

  const id = normalizeId(payload.id)
  if (requireId && !id) return { error: "project id is required", value: null }
  if (id && !PROJECT_ID_RE.test(id)) {
    return { error: "project id must be 2-63 chars: lowercase letters, numbers, hyphens", value: null }
  }

  const name = String(payload.name || "").trim()
  if (!name) return { error: "project name is required", value: null }

  const chainSelectorName = String(payload.chainSelectorName || "").trim()
  if (!chainSelectorName) return { error: "chain selector is required", value: null }

  const receiverAddress = String(payload.receiverAddress || "").trim()
  if (!receiverAddress) return { error: "receiver address is required", value: null }
  if (!isAddress(receiverAddress)) return { error: "receiver address is invalid", value: null }

  const liabilityTokenAddress = String(payload.liabilityTokenAddress || "").trim()
  if (!liabilityTokenAddress) return { error: "liability token address is required", value: null }
  if (!isAddress(liabilityTokenAddress)) return { error: "liability token address is invalid", value: null }

  const rpcUrl = String(payload.rpcUrl || "").trim()
  if (!rpcUrl) return { error: "rpc url is required", value: null }

  const explorerBaseUrl = String(payload.explorerBaseUrl || "").trim()
  if (!explorerBaseUrl) return { error: "explorer base url is required", value: null }

  const supplyChainSelectorName = String(payload.supplyChainSelectorName || "").trim()
  const supplyRpcUrl = String(payload.supplyRpcUrl || "").trim()
  const supplyLiabilityTokenAddress = String(payload.supplyLiabilityTokenAddress || "").trim()

  if (supplyLiabilityTokenAddress && !isAddress(supplyLiabilityTokenAddress)) {
    return { error: "supply liability token address is invalid", value: null }
  }

  const supplyDiffers =
    supplyChainSelectorName &&
    chainSelectorName &&
    supplyChainSelectorName.toLowerCase() !== chainSelectorName.toLowerCase()

  if (supplyDiffers && !supplyRpcUrl) {
    return { error: "supply rpc url is required when supply chain differs", value: null }
  }

  const expectedForwarderAddress = String(payload.expectedForwarderAddress || "").trim()
  if (expectedForwarderAddress && !isAddress(expectedForwarderAddress)) {
    return { error: "expected forwarder address is invalid", value: null }
  }

  const maxReserveAge = parseOptionalNumber(payload.maxReserveAgeS, "maxReserveAgeS", { min: 0 })
  if (maxReserveAge.error) return { error: maxReserveAge.error, value: null }

  const maxMismatch = parseOptionalNumber(payload.maxReserveMismatchRatio, "maxReserveMismatchRatio", { min: 0 })
  if (maxMismatch.error) return { error: maxMismatch.error, value: null }

  const project = {
    id,
    name,
    symbol: String(payload.symbol || "").trim(),
    chainSelectorName,
    rpcUrl,
    supplyChainSelectorName,
    supplyRpcUrl,
    explorerBaseUrl,
    receiverAddress,
    liabilityTokenAddress,
    supplyLiabilityTokenAddress,
    expectedForwarderAddress,
    maxReserveAgeS: maxReserveAge.value,
    maxReserveMismatchRatio: maxMismatch.value,
  }

  return { error: "", value: project }
}

const normalizeConnectorPayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    return { error: "connector payload is required", value: null }
  }

  const projectId = normalizeId(payload.projectId)
  if (!projectId) return { error: "projectId is required", value: null }

  const id = normalizeConnectorId(payload.id)
  if (!id) return { error: "connector id is required", value: null }
  if (!CONNECTOR_ID_RE.test(id)) {
    return { error: "connector id must be 2-63 chars: lowercase letters, numbers, hyphens", value: null }
  }

  const name = String(payload.name || "").trim()
  if (!name) return { error: "connector name is required", value: null }

  const role = String(payload.role || "").trim()
  if (!role) return { error: "connector role is required", value: null }
  if (role !== "primary" && role !== "secondary") {
    return { error: "connector role must be primary or secondary", value: null }
  }

  const url = String(payload.url || "").trim()
  if (!url) return { error: "connector url is required", value: null }

  const expectedSigner = String(payload.expectedSigner || "").trim()
  if (expectedSigner && !isAddress(expectedSigner)) {
    return { error: "expected signer address is invalid", value: null }
  }

  const lastTestedAt = numberOrNull(payload.lastTestedAt)
  const lastTestOk = typeof payload.lastTestOk === "boolean" ? payload.lastTestOk : null
  const lastTestMessage = typeof payload.lastTestMessage === "string" ? payload.lastTestMessage : ""

  return {
    error: "",
    value: {
      id,
      projectId,
      type: String(payload.type || "http_reserve").trim() || "http_reserve",
      name,
      role,
      url,
      expectedSigner,
      lastTestedAt,
      lastTestOk,
      lastTestMessage,
    },
  }
}

const normalizePolicyPayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    return { error: "policy payload is required", value: null }
  }

  const projectId = normalizeId(payload.projectId)
  if (!projectId) return { error: "projectId is required", value: null }

  const consensusMode = String(payload.consensusMode || "require_match").trim()
  if (!consensusMode) return { error: "consensus mode is required", value: null }
  if (consensusMode !== "primary_only" && consensusMode !== "require_match" && consensusMode !== "conservative_min") {
    return { error: "consensus mode is invalid", value: null }
  }

  const minCoverage = parseOptionalNumber(payload.minCoverageBps, "minCoverageBps", { min: 0 })
  if (minCoverage.error) return { error: minCoverage.error, value: null }

  const maxReserveAge = parseOptionalNumber(payload.maxReserveAgeS, "maxReserveAgeS", { min: 0 })
  if (maxReserveAge.error) return { error: maxReserveAge.error, value: null }

  const maxMismatch = parseOptionalNumber(payload.maxMismatchRatio, "maxMismatchRatio", { min: 0 })
  if (maxMismatch.error) return { error: maxMismatch.error, value: null }

  return {
    error: "",
    value: {
      projectId,
      consensusMode,
      minCoverageBps: minCoverage.value,
      maxReserveAgeS: maxReserveAge.value,
      maxMismatchRatio: maxMismatch.value,
      updatedAt: Number(payload.updatedAt) || Date.now(),
    },
  }
}

const readJsonFile = (targetPath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(targetPath, "utf8"))
  } catch {
    return fallback
  }
}

const writeJsonFile = (targetPath, payload) => {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${targetPath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n")
  fs.renameSync(tmpPath, targetPath)
}

const resolveDraftJsonPath = (targetPath) => {
  const p = String(targetPath || "")
  if (!p) return p
  if (p.toLowerCase().endsWith(".json")) {
    return p.slice(0, -5) + "-draft.json"
  }
  return `${p}-draft`
}

const readDraftFlag = (req) => {
  const q = req?.query?.draft
  const b = req?.body?.draft
  const raw = q !== undefined ? q : b
  if (raw === true || raw === 1) return true
  const s = String(raw || "").trim().toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
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

const resolveProjectsPath = ({ draft = false } = {}) => {
  const override = draft ? process.env.RESERVEWATCH_DRAFT_PROJECTS_PATH : process.env.RESERVEWATCH_PROJECTS_PATH
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override)
  }

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const live = path.resolve(__dirname, "./projects.json")
  return draft ? resolveDraftJsonPath(live) : live
}

const loadProjectsConfig = ({ draft = false } = {}) => {
  const p = resolveProjectsPath({ draft })
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

const loadProjectsStore = ({ draft = false } = {}) => {
  const cfg = loadProjectsConfig({ draft })
  if (cfg) {
    if (draft) {
      const hasProjects = Array.isArray(cfg.projects) && cfg.projects.length > 0
      if (!hasProjects) {
        const liveCfg = loadProjectsConfig({ draft: false })
        if (liveCfg?.projects?.length) {
          return {
            path: resolveProjectsPath({ draft: true }),
            defaultProjectId: liveCfg.defaultProjectId,
            projects: Array.isArray(liveCfg.projects) ? liveCfg.projects : [],
          }
        }
      }
    }
    return cfg
  }

  if (draft) {
    const liveCfg = loadProjectsConfig({ draft: false })
    if (liveCfg) {
      return {
        path: resolveProjectsPath({ draft: true }),
        defaultProjectId: liveCfg.defaultProjectId,
        projects: Array.isArray(liveCfg.projects) ? liveCfg.projects : [],
      }
    }
  }
  return {
    path: resolveProjectsPath({ draft }),
    defaultProjectId: null,
    projects: [],
  }
}

const saveProjectsConfig = (cfg) => {
  writeJsonFile(cfg.path, {
    defaultProjectId: cfg.defaultProjectId || null,
    projects: Array.isArray(cfg.projects) ? cfg.projects : [],
  })
}

const resolveConnectorsPath = ({ draft = false } = {}) => {
  const override = draft ? process.env.RESERVEWATCH_DRAFT_CONNECTORS_PATH : process.env.RESERVEWATCH_CONNECTORS_PATH
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override)
  }

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const live = path.resolve(__dirname, "./connectors.json")
  return draft ? resolveDraftJsonPath(live) : live
}

const loadConnectorsConfig = ({ draft = false } = {}) => {
  const p = resolveConnectorsPath({ draft })
  const raw = readJsonFile(p, null)
  const rawLive = draft && raw === null ? readJsonFile(resolveConnectorsPath({ draft: false }), null) : raw
  const connectors = Array.isArray(rawLive?.connectors) ? rawLive.connectors : Array.isArray(rawLive) ? rawLive : []
  return {
    path: p,
    connectors,
  }
}

const saveConnectorsConfig = (cfg) => {
  writeJsonFile(cfg.path, {
    connectors: Array.isArray(cfg.connectors) ? cfg.connectors : [],
  })
}

const resolvePoliciesPath = ({ draft = false } = {}) => {
  const override = draft
    ? process.env.RESERVEWATCH_DRAFT_POLICIES_PATH || process.env.RESERVEWATCH_DRAFT_POLICY_PATH
    : process.env.RESERVEWATCH_POLICIES_PATH || process.env.RESERVEWATCH_POLICY_PATH
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override)
  }

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const live = path.resolve(__dirname, "./policies.json")
  return draft ? resolveDraftJsonPath(live) : live
}

const loadPoliciesConfig = ({ draft = false } = {}) => {
  const p = resolvePoliciesPath({ draft })
  const raw = readJsonFile(p, null)
  const rawLive = draft && raw === null ? readJsonFile(resolvePoliciesPath({ draft: false }), null) : raw
  const policies = Array.isArray(rawLive?.policies) ? rawLive.policies : Array.isArray(rawLive) ? rawLive : []
  return {
    path: p,
    policies,
  }
}

const savePoliciesConfig = (cfg) => {
  writeJsonFile(cfg.path, {
    policies: Array.isArray(cfg.policies) ? cfg.policies : [],
  })
}

const getFallbackProject = () => {
  const cfg = loadWorkflowConfig()
  return {
    id: "default",
    name: "Default (workflow config)",
    symbol: "",
    chainSelectorName: process.env.CHAIN_SELECTOR_NAME || cfg?.chainSelectorName || "ethereum-testnet-sepolia",
    supplyChainSelectorName: cfg?.supplyChainSelectorName || null,
    supplyRpcUrl: cfg?.supplyRpcUrl || null,
    supplyLiabilityTokenAddress: cfg?.supplyLiabilityTokenAddress || null,
    receiverAddress: process.env.RECEIVER_ADDRESS || cfg?.receiverAddress || "",
    liabilityTokenAddress: process.env.LIABILITY_TOKEN_ADDRESS || cfg?.liabilityTokenAddress || "",
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    explorerBaseUrl: process.env.EXPLORER_BASE_URL || "https://sepolia.etherscan.io",
    expectedForwarderAddress: process.env.EXPECTED_FORWARDER_ADDRESS || null,
    maxReserveAgeS: process.env.MAX_RESERVE_AGE_S ? Number(process.env.MAX_RESERVE_AGE_S) : null,
    maxReserveMismatchRatio: process.env.MAX_RESERVE_MISMATCH_RATIO ? Number(process.env.MAX_RESERVE_MISMATCH_RATIO) : null,
  }
}

const listProjects = ({ draft = false } = {}) => {
  const cfg = draft ? loadProjectsStore({ draft: true }) : loadProjectsConfig({ draft: false })
  const fallback = getFallbackProject()

  if (cfg?.projects?.length) {
    return cfg.projects
      .filter((p) => p && typeof p.id === "string")
      .map((p) => ({
        id: p.id,
        name: p.name || p.id,
        symbol: p.symbol || "",
        chainSelectorName: p.chainSelectorName || fallback.chainSelectorName || "",
        supplyChainSelectorName: p.supplyChainSelectorName || null,
        supplyRpcUrl: p.supplyRpcUrl || null,
        receiverAddress: p.receiverAddress || "",
        liabilityTokenAddress: p.liabilityTokenAddress || "",
        supplyLiabilityTokenAddress: p.supplyLiabilityTokenAddress || null,
        rpcUrl: p.rpcUrl || fallback.rpcUrl,
        explorerBaseUrl: p.explorerBaseUrl || fallback.explorerBaseUrl,
        expectedForwarderAddress: p.expectedForwarderAddress || null,
        maxReserveAgeS: Number.isFinite(Number(p.maxReserveAgeS)) ? Number(p.maxReserveAgeS) : null,
        maxReserveMismatchRatio: Number.isFinite(Number(p.maxReserveMismatchRatio)) ? Number(p.maxReserveMismatchRatio) : null,
      }))
  }

  return [fallback]
}

const getProjectById = (projectId, { draft = false } = {}) => {
  const all = listProjects({ draft })

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

const listConnectors = (projectId = null, { draft = false } = {}) => {
  const cfg = loadConnectorsConfig({ draft })
  const all = Array.isArray(cfg?.connectors) ? cfg.connectors : []
  const pid = projectId ? normalizeId(projectId) : null
  return all.filter((c) => {
    if (!c || typeof c.id !== "string" || typeof c.projectId !== "string") return false
    if (!pid) return true
    return normalizeId(c.projectId) === pid
  })
}

const listPolicies = (projectId = null, { draft = false } = {}) => {
  const cfg = loadPoliciesConfig({ draft })
  const all = Array.isArray(cfg?.policies) ? cfg.policies : []
  const pid = projectId ? normalizeId(projectId) : null
  return all.filter((p) => {
    if (!p || typeof p.projectId !== "string") return false
    if (!pid) return true
    return normalizeId(p.projectId) === pid
  })
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

app.post("/admin/run", (req, res) => {
  const broadcast = Boolean(req.body?.broadcast)
  const target = typeof req.body?.target === "string" && req.body.target.trim() ? req.body.target.trim() : "staging-settings"
  const workflow = typeof req.body?.workflow === "string" && req.body.workflow.trim() ? req.body.workflow.trim() : "reservewatch-workflow"

  if (activeRun && activeRun.state === "running") {
    res.status(409).json({ error: "run already in progress", runId: activeRun.runId, run: activeRun })
    return
  }

  const runId = createRunId()
  const run = {
    runId,
    state: "running",
    workflow,
    target,
    broadcast,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    output: "",
  }

  runsById.set(runId, run)
  activeRun = run

  const args = ["workflow", "simulate", workflow, "--target", target]
  if (broadcast) args.push("--broadcast")
  if (fs.existsSync(defaultEnvPath)) args.push("--env", defaultEnvPath)

  try {
    const child = spawn("cre", args, {
      cwd: reservewatchRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })

    child.stdout?.on("data", (chunk) => appendRunOutput(run, chunk))
    child.stderr?.on("data", (chunk) => appendRunOutput(run, chunk))

    child.on("error", (err) => {
      run.state = "failed"
      run.error = String(err?.message || err)
      run.exitCode = null
      run.finishedAt = new Date().toISOString()
      activeRun = null
    })

    child.on("exit", (code) => {
      run.exitCode = typeof code === "number" ? code : null
      run.state = code === 0 ? "ok" : "failed"
      run.finishedAt = new Date().toISOString()
      activeRun = null
    })

    res.json({ runId, run })
  } catch (err) {
    run.state = "failed"
    run.error = String(err?.message || err)
    run.finishedAt = new Date().toISOString()
    activeRun = null
    res.status(500).json({ error: run.error, runId, run })
  }
})

app.get("/admin/run/:runId", (req, res) => {
  const runId = String(req.params?.runId || "").trim()
  if (!runId) {
    res.status(400).json({ error: "missing runId" })
    return
  }

  const run = runsById.get(runId)
  if (!run) {
    res.status(404).json({ error: "run not found" })
    return
  }

  res.json({ runId, run })
})

app.get("/admin/run", (req, res) => {
  const runs = Array.from(runsById.values())
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
    .slice(0, 10)
  res.json({ activeRun: activeRun && activeRun.state === "running" ? activeRun : null, runs })
})

app.get("/incident/feed", (req, res) => {
  const projectId = typeof req.query?.project === "string" ? req.query.project : null
  res.json({ projectId: projectId || "default", incident: getIncidentState(projectId) })
})

app.get("/api/projects", (req, res) => {
  const draft = readDraftFlag(req)
  const store = loadProjectsStore({ draft })
  const projects = listProjects({ draft })
  res.json({ defaultProjectId: store.defaultProjectId, projects })
})

app.post("/api/projects", requireAdmin, (req, res) => {
  const draft = readDraftFlag(req)
  const result = normalizeProjectPayload(req.body)
  if (result.error) {
    res.status(400).json({ error: result.error })
    return
  }

  const store = loadProjectsStore({ draft })
  const nextId = normalizeId(result.value.id)

  const exists = store.projects.some((p) => normalizeId(p?.id) === nextId)
  if (exists) {
    res.status(409).json({ error: "project already exists" })
    return
  }

  store.projects = [...store.projects, result.value]
  const makeDefault = Boolean(req.body?.makeDefault)
  if (!store.defaultProjectId || makeDefault) {
    store.defaultProjectId = nextId
  }

  saveProjectsConfig(store)
  res.json({ project: result.value, defaultProjectId: store.defaultProjectId })
})

app.put("/api/projects", requireAdmin, (req, res) => {
  const draft = readDraftFlag(req)
  const targetId = normalizeId(req.body?.previousId || req.body?.id || req.query?.id)
  if (!targetId) {
    res.status(400).json({ error: "project id is required" })
    return
  }

  const payload = { ...req.body, id: req.body?.id || targetId }
  const result = normalizeProjectPayload(payload)
  if (result.error) {
    res.status(400).json({ error: result.error })
    return
  }

  const store = loadProjectsStore({ draft })
  const idx = store.projects.findIndex((p) => normalizeId(p?.id) === targetId)
  if (idx < 0) {
    res.status(404).json({ error: "project not found" })
    return
  }

  const nextId = normalizeId(result.value.id)
  if (nextId !== targetId) {
    const conflict = store.projects.some((p, i) => i !== idx && normalizeId(p?.id) === nextId)
    if (conflict) {
      res.status(409).json({ error: "project id already exists" })
      return
    }
  }

  store.projects[idx] = result.value

  if (store.defaultProjectId === targetId) {
    store.defaultProjectId = nextId
  }

  if (nextId !== targetId) {
    const connectorsCfg = loadConnectorsConfig({ draft })
    connectorsCfg.connectors = (Array.isArray(connectorsCfg.connectors) ? connectorsCfg.connectors : []).map((c) => {
      if (!c || typeof c.projectId !== "string") return c
      if (normalizeId(c.projectId) !== targetId) return c
      return { ...c, projectId: nextId }
    })
    saveConnectorsConfig(connectorsCfg)

    const policiesCfg = loadPoliciesConfig({ draft })
    policiesCfg.policies = (Array.isArray(policiesCfg.policies) ? policiesCfg.policies : []).map((p) => {
      if (!p || typeof p.projectId !== "string") return p
      if (normalizeId(p.projectId) !== targetId) return p
      return { ...p, projectId: nextId }
    })
    savePoliciesConfig(policiesCfg)
  }

  saveProjectsConfig(store)
  res.json({ project: store.projects[idx], defaultProjectId: store.defaultProjectId })
})

app.delete("/api/projects", requireAdmin, (req, res) => {
  const draft = readDraftFlag(req)
  const targetId = normalizeId(req.body?.id || req.query?.id)
  if (!targetId) {
    res.status(400).json({ error: "project id is required" })
    return
  }

  const store = loadProjectsStore({ draft })
  const before = store.projects.length
  store.projects = store.projects.filter((p) => normalizeId(p?.id) !== targetId)
  if (before === store.projects.length) {
    res.status(404).json({ error: "project not found" })
    return
  }

  if (store.defaultProjectId === targetId) {
    store.defaultProjectId = store.projects[0]?.id || null
  }

  saveProjectsConfig(store)

  const connectorsCfg = loadConnectorsConfig({ draft })
  connectorsCfg.connectors = (Array.isArray(connectorsCfg.connectors) ? connectorsCfg.connectors : []).filter(
    (c) => normalizeId(c?.projectId) !== targetId
  )
  saveConnectorsConfig(connectorsCfg)

  const policiesCfg = loadPoliciesConfig({ draft })
  policiesCfg.policies = (Array.isArray(policiesCfg.policies) ? policiesCfg.policies : []).filter(
    (p) => normalizeId(p?.projectId) !== targetId
  )
  savePoliciesConfig(policiesCfg)

  res.json({ ok: true, defaultProjectId: store.defaultProjectId })
})

app.get("/api/connectors", (req, res) => {
  const draft = readDraftFlag(req)
  const projectId =
    typeof req.query?.project === "string"
      ? req.query.project
      : typeof req.query?.projectId === "string"
        ? req.query.projectId
        : null
  const connectors = listConnectors(projectId, { draft })
  res.json({ projectId: projectId || null, connectors })
})

app.post("/api/connectors", requireAdmin, (req, res) => {
  const draft = readDraftFlag(req)
  const result = normalizeConnectorPayload(req.body)
  if (result.error) {
    res.status(400).json({ error: result.error })
    return
  }

  const projectExists = listProjects({ draft }).some((p) => normalizeId(p?.id) === normalizeId(result.value.projectId))
  if (!projectExists) {
    res.status(404).json({ error: "project not found" })
    return
  }

  const cfg = loadConnectorsConfig({ draft })
  const connectors = Array.isArray(cfg.connectors) ? cfg.connectors : []
  const exists = connectors.some(
    (c) => normalizeId(c?.projectId) === result.value.projectId && normalizeConnectorId(c?.id) === result.value.id
  )
  if (exists) {
    res.status(409).json({ error: "connector already exists" })
    return
  }

  cfg.connectors = [...connectors, result.value]
  saveConnectorsConfig(cfg)
  res.json({ connector: result.value })
})

app.put("/api/connectors", requireAdmin, (req, res) => {
  const draft = readDraftFlag(req)
  const targetProjectId = normalizeId(req.body?.previousProjectId || req.body?.projectId || req.query?.projectId || req.query?.project)
  const targetId = normalizeConnectorId(req.body?.previousId || req.body?.id || req.query?.id)
  if (!targetProjectId || !targetId) {
    res.status(400).json({ error: "projectId and connector id are required" })
    return
  }

  const payload = {
    ...req.body,
    projectId: req.body?.projectId || targetProjectId,
    id: req.body?.id || targetId,
  }
  const result = normalizeConnectorPayload(payload)
  if (result.error) {
    res.status(400).json({ error: result.error })
    return
  }

  const projectExists = listProjects({ draft }).some((p) => normalizeId(p?.id) === normalizeId(result.value.projectId))
  if (!projectExists) {
    res.status(404).json({ error: "project not found" })
    return
  }

  const cfg = loadConnectorsConfig({ draft })
  const connectors = Array.isArray(cfg.connectors) ? cfg.connectors : []
  const idx = connectors.findIndex(
    (c) => normalizeId(c?.projectId) === targetProjectId && normalizeConnectorId(c?.id) === targetId
  )
  if (idx < 0) {
    res.status(404).json({ error: "connector not found" })
    return
  }

  if (result.value.projectId !== targetProjectId || result.value.id !== targetId) {
    const conflict = connectors.some(
      (c, i) =>
        i !== idx &&
        normalizeId(c?.projectId) === result.value.projectId &&
        normalizeConnectorId(c?.id) === result.value.id
    )
    if (conflict) {
      res.status(409).json({ error: "connector id already exists" })
      return
    }
  }

  connectors[idx] = result.value
  cfg.connectors = connectors
  saveConnectorsConfig(cfg)
  res.json({ connector: result.value })
})

app.delete("/api/connectors", requireAdmin, (req, res) => {
  const draft = readDraftFlag(req)
  const projectId = normalizeId(req.body?.projectId || req.query?.projectId || req.query?.project)
  const id = normalizeConnectorId(req.body?.id || req.query?.id)
  if (!projectId || !id) {
    res.status(400).json({ error: "projectId and connector id are required" })
    return
  }

  const cfg = loadConnectorsConfig({ draft })
  const connectors = Array.isArray(cfg.connectors) ? cfg.connectors : []
  const next = connectors.filter(
    (c) => !(normalizeId(c?.projectId) === projectId && normalizeConnectorId(c?.id) === id)
  )

  if (next.length === connectors.length) {
    res.status(404).json({ error: "connector not found" })
    return
  }

  cfg.connectors = next
  saveConnectorsConfig(cfg)
  res.json({ ok: true })
})

const handlePolicyGet = (req, res) => {
  const draft = readDraftFlag(req)
  const projectId =
    typeof req.query?.project === "string"
      ? req.query.project
      : typeof req.query?.projectId === "string"
        ? req.query.projectId
        : null
  const policies = listPolicies(projectId, { draft })
  if (projectId) {
    res.json({ projectId, policy: policies[0] || null })
    return
  }
  res.json({ policies })
}

const handlePolicyPost = (req, res) => {
  const draft = readDraftFlag(req)
  const result = normalizePolicyPayload(req.body)
  if (result.error) {
    res.status(400).json({ error: result.error })
    return
  }

  const projectExists = listProjects({ draft }).some((p) => normalizeId(p?.id) === normalizeId(result.value.projectId))
  if (!projectExists) {
    res.status(404).json({ error: "project not found" })
    return
  }

  const cfg = loadPoliciesConfig({ draft })
  const policies = Array.isArray(cfg.policies) ? cfg.policies : []
  const exists = policies.some((p) => normalizeId(p?.projectId) === result.value.projectId)
  if (exists) {
    res.status(409).json({ error: "policy already exists" })
    return
  }

  cfg.policies = [...policies, result.value]
  savePoliciesConfig(cfg)
  res.json({ policy: result.value })
}

const handlePolicyPut = (req, res) => {
  const draft = readDraftFlag(req)
  const targetProjectId = normalizeId(req.body?.previousProjectId || req.body?.projectId || req.query?.projectId || req.query?.project)
  if (!targetProjectId) {
    res.status(400).json({ error: "projectId is required" })
    return
  }

  const payload = { ...req.body, projectId: req.body?.projectId || targetProjectId }
  const result = normalizePolicyPayload(payload)
  if (result.error) {
    res.status(400).json({ error: result.error })
    return
  }

  const projectExists = listProjects({ draft }).some((p) => normalizeId(p?.id) === normalizeId(result.value.projectId))
  if (!projectExists) {
    res.status(404).json({ error: "project not found" })
    return
  }

  const cfg = loadPoliciesConfig({ draft })
  const policies = Array.isArray(cfg.policies) ? cfg.policies : []
  const idx = policies.findIndex((p) => normalizeId(p?.projectId) === targetProjectId)
  if (idx < 0) {
    res.status(404).json({ error: "policy not found" })
    return
  }

  policies[idx] = result.value
  cfg.policies = policies
  savePoliciesConfig(cfg)
  res.json({ policy: result.value })
}

const handlePolicyDelete = (req, res) => {
  const draft = readDraftFlag(req)
  const projectId = normalizeId(req.body?.projectId || req.query?.projectId || req.query?.project)
  if (!projectId) {
    res.status(400).json({ error: "projectId is required" })
    return
  }

  const cfg = loadPoliciesConfig({ draft })
  const policies = Array.isArray(cfg.policies) ? cfg.policies : []
  const next = policies.filter((p) => normalizeId(p?.projectId) !== projectId)
  if (next.length === policies.length) {
    res.status(404).json({ error: "policy not found" })
    return
  }

  cfg.policies = next
  savePoliciesConfig(cfg)
  res.json({ ok: true })
}

app.get("/api/policy", handlePolicyGet)
app.get("/api/policies", handlePolicyGet)
app.post("/api/policy", requireAdmin, handlePolicyPost)
app.post("/api/policies", requireAdmin, handlePolicyPost)
app.put("/api/policy", requireAdmin, handlePolicyPut)
app.put("/api/policies", requireAdmin, handlePolicyPut)
app.delete("/api/policy", requireAdmin, handlePolicyDelete)
app.delete("/api/policies", requireAdmin, handlePolicyDelete)

app.post("/api/publish", requireAdmin, (req, res) => {
  const draftProjects = loadProjectsStore({ draft: true })
  const draftConnectors = loadConnectorsConfig({ draft: true })
  const draftPolicies = loadPoliciesConfig({ draft: true })

  const liveProjects = loadProjectsStore({ draft: false })
  liveProjects.defaultProjectId = draftProjects.defaultProjectId || null
  liveProjects.projects = Array.isArray(draftProjects.projects) ? draftProjects.projects : []
  saveProjectsConfig(liveProjects)

  const liveConnectors = loadConnectorsConfig({ draft: false })
  liveConnectors.connectors = Array.isArray(draftConnectors.connectors) ? draftConnectors.connectors : []
  saveConnectorsConfig(liveConnectors)

  const livePolicies = loadPoliciesConfig({ draft: false })
  livePolicies.policies = Array.isArray(draftPolicies.policies) ? draftPolicies.policies : []
  savePoliciesConfig(livePolicies)

  saveProjectsConfig({ ...draftProjects, projects: liveProjects.projects, defaultProjectId: liveProjects.defaultProjectId })
  saveConnectorsConfig({ ...draftConnectors, connectors: liveConnectors.connectors })
  savePoliciesConfig({ ...draftPolicies, policies: livePolicies.policies })

  res.json({ ok: true })
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
