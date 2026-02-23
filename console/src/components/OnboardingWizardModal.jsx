import { useEffect, useMemo, useRef, useState } from "react"

import {
  createPublicClient,
  http,
  isAddress,
  parseAbi,
  recoverMessageAddress,
} from "viem"
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon, sepolia } from "viem/chains"

import StatusPill from "./StatusPill"

const emptyProject = {
  id: "",
  name: "",
  symbol: "",
  chainSelectorName: "ethereum-testnet-sepolia",
  rpcUrl: "",
  supplyChainSelectorName: "",
  supplyRpcUrl: "",
  explorerBaseUrl: "https://sepolia.etherscan.io",
  receiverAddress: "",
  liabilityTokenAddress: "",
  supplyLiabilityTokenAddress: "",
  expectedForwarderAddress: "",
  maxReserveAgeS: "",
  maxReserveMismatchRatio: "",
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const normalizeAddress = (addr) => {
  if (!addr) return ""
  return String(addr).trim().toLowerCase()
}

const resolveChain = (chainSelectorName) => {
  const key = String(chainSelectorName || "")
    .trim()
    .toLowerCase()

  if (!key) return sepolia
  if (key.includes("sepolia")) return sepolia
  if (key.includes("mainnet") || key === "ethereum") return mainnet
  if (key.includes("polygon")) return polygon
  if (key.includes("arbitrum")) return arbitrum
  if (key.includes("optimism")) return optimism
  if (key.includes("base")) return base
  if (key.includes("avalanche")) return avalanche
  if (key.includes("bsc") || key.includes("binance")) return bsc

  return sepolia
}

const receiverAbi = parseAbi([
  "function lastCoverageBps() view returns (uint256)",
  "function minCoverageBps() view returns (uint256)",
  "function mintingPaused() view returns (bool)",
  "function owner() view returns (address)",
  "function getForwarderAddress() view returns (address)",
])

const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function mintingEnabled() view returns (bool)",
])

const normalizeId = (value) => String(value || "").trim()

const normalizeConnectorId = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
}

const asText = (value) => {
  if (value === null || value === undefined) return ""
  return String(value)
}

const jsonStableStringify = (obj) => JSON.stringify(obj, null, 2)

const toProjectIdSlug = (value) => {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
  if (!raw) return ""
  const cleaned = raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "")
  if (!cleaned) return ""
  const clipped = cleaned.slice(0, 63)
  if (clipped.length >= 2) return clipped
  return `${clipped}1`
}

const TEMPLATES = [
  {
    id: "custom",
    label: "Custom",
    project: {},
    policy: {},
  },
  {
    id: "sepolia",
    label: "Sepolia",
    project: {
      chainSelectorName: "ethereum-testnet-sepolia",
      explorerBaseUrl: "https://sepolia.etherscan.io",
      rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    },
    policy: {
      consensusMode: "require_match",
      maxReserveAgeS: "120",
      maxMismatchRatio: "0.01",
    },
  },
]

const httpGetJson = async (url, { timeoutMs = 10_000 } = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`HTTP ${res.status}${text ? ` ${text}` : ""}`)
    }
    return res.json()
  } finally {
    clearTimeout(timeout)
  }
}

const downloadText = (filename, content, contentType = "application/json") => {
  try {
    const blob = new Blob([content], { type: contentType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 500)
  } catch {
    return
  }
}

const toFiniteNumber = (value) => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const reserveMessage = ({ timestamp, reserveUsd, navUsd, source }) => {
  const ts = Number(timestamp)
  const r = String(reserveUsd)
  const s = String(source || "")
  if (navUsd !== undefined && navUsd !== null) {
    return `ReserveWatch:v2|source=${s}|reserveUsd=${r}|navUsd=${String(navUsd)}|timestamp=${ts}`
  }
  return `ReserveWatch:v1|source=${s}|reserveUsd=${r}|timestamp=${ts}`
}

const verifyReserveSignature = async ({ reserve, expectedSigner }) => {
  const signature = reserve?.signature
  const declaredSigner = reserve?.signer
  const expected = String(expectedSigner || "").trim()

  if (!signature || !declaredSigner) {
    return {
      signatureValid: expected ? false : null,
      recoveredSigner: null,
      signatureError: expected ? "missing signer/signature" : null,
    }
  }

  try {
    const recoveredSigner = await recoverMessageAddress({
      message: reserveMessage(reserve),
      signature,
    })

    const okDeclared = normalizeAddress(recoveredSigner) === normalizeAddress(declaredSigner)
    const okExpected = expected ? normalizeAddress(recoveredSigner) === normalizeAddress(expected) : null

    if (expected) {
      return {
        signatureValid: Boolean(okDeclared && okExpected),
        recoveredSigner,
        signatureError: null,
      }
    }

    return {
      signatureValid: okDeclared,
      recoveredSigner,
      signatureError: null,
    }
  } catch (err) {
    return {
      signatureValid: expected ? false : null,
      recoveredSigner: null,
      signatureError: String(err?.message || err),
    }
  }
}

const computeDerivedPreview = ({ reserves, onchain, project, policy }) => {
  const now = Math.floor(Date.now() / 1000)

  const consensusMode = policy?.consensusMode || "require_match"

  const primarySigInvalid = reserves?.primary?.signatureValid === false
  const secondarySigInvalid = reserves?.secondary?.signatureValid === false
  const reserveSignatureInvalid =
    consensusMode === "primary_only" ? primarySigInvalid : primarySigInvalid || secondarySigInvalid

  const maxReserveAgeS = (() => {
    const fromPolicy = toFiniteNumber(policy?.maxReserveAgeS)
    if (Number.isFinite(fromPolicy)) return fromPolicy
    const fromProject = toFiniteNumber(project?.maxReserveAgeS)
    if (Number.isFinite(fromProject)) return fromProject
    return 120
  })()

  const maxMismatchRatio = (() => {
    const fromPolicy = toFiniteNumber(policy?.maxMismatchRatio)
    if (Number.isFinite(fromPolicy)) return fromPolicy
    const fromProject = toFiniteNumber(project?.maxReserveMismatchRatio)
    if (Number.isFinite(fromProject)) return fromProject
    return 0.01
  })()

  const minCoverageBpsOverride = toFiniteNumber(policy?.minCoverageBps)

  const primaryTs = reserves?.primary?.timestamp
  const secondaryTs = reserves?.secondary?.timestamp

  const primaryAgeS = typeof primaryTs === "number" ? now - primaryTs : null
  const secondaryAgeS = typeof secondaryTs === "number" ? now - secondaryTs : null

  const primaryOk = Boolean(reserves?.primary && typeof primaryTs === "number")
  const secondaryOk = Boolean(reserves?.secondary && typeof secondaryTs === "number")

  const reserveStale = (() => {
    if (!Number.isFinite(maxReserveAgeS)) return false

    if (consensusMode === "primary_only") {
      if (!primaryOk || primarySigInvalid) return true
      return typeof primaryAgeS === "number" ? primaryAgeS > maxReserveAgeS : true
    }

    if (!primaryOk || !secondaryOk || primarySigInvalid || secondarySigInvalid) return true

    return (
      (typeof primaryAgeS === "number" && primaryAgeS > maxReserveAgeS) ||
      (typeof secondaryAgeS === "number" && secondaryAgeS > maxReserveAgeS)
    )
  })()

  const primaryReserveUsd = toFiniteNumber(reserves?.primary?.reserveUsd)
  const secondaryReserveUsd = toFiniteNumber(reserves?.secondary?.reserveUsd)

  let reserveMismatchUsd = null
  let reserveMismatchRatio = null
  let sourceMismatch = false

  if (typeof primaryReserveUsd === "number" && typeof secondaryReserveUsd === "number") {
    reserveMismatchUsd = Math.abs(primaryReserveUsd - secondaryReserveUsd)
    const denom = Math.max(primaryReserveUsd, secondaryReserveUsd, 1)
    reserveMismatchRatio = reserveMismatchUsd / denom
    if (consensusMode === "require_match") {
      sourceMismatch = reserveMismatchRatio > maxMismatchRatio
    }
  }

  const coverageBps = toFiniteNumber(onchain?.receiver?.lastCoverageBps)
  const onchainMinCoverageBps = toFiniteNumber(onchain?.receiver?.minCoverageBps)
  const minCoverageBps = Number.isFinite(minCoverageBpsOverride) ? minCoverageBpsOverride : onchainMinCoverageBps

  const mintingPaused = onchain?.receiver?.mintingPaused
  const mintingEnabled = onchain?.token?.mintingEnabled
  const enforcementHookWired = Boolean(onchain?.enforcement?.hookWired)
  const forwarderSet = Boolean(onchain?.enforcement?.forwarderSet)

  const reasons = []
  if (onchain?.error) reasons.push("onchain_unavailable")
  if (reserveStale) reasons.push("reserve_data_stale")
  if (reserveSignatureInvalid) reasons.push("reserve_signature_invalid")
  if (sourceMismatch) reasons.push("reserve_source_mismatch")
  if (!enforcementHookWired) reasons.push("enforcement_not_wired")
  if (!forwarderSet) reasons.push("forwarder_not_set")
  if (mintingPaused === true) reasons.push("minting_paused")
  if (mintingEnabled === false) reasons.push("minting_disabled")
  if (Number.isFinite(coverageBps) && Number.isFinite(minCoverageBps) && coverageBps < minCoverageBps) {
    reasons.push("coverage_below_threshold")
  }

  let status = "HEALTHY"
  if (onchain?.error || reserveStale || reserveSignatureInvalid) status = "STALE"
  else if (sourceMismatch) status = "DEGRADED"
  else if (!enforcementHookWired) status = "DEGRADED"
  else if (!forwarderSet) status = "DEGRADED"
  else if (reasons.includes("coverage_below_threshold") || reasons.includes("minting_paused") || reasons.includes("minting_disabled")) {
    status = "UNHEALTHY"
  }

  return {
    now,
    consensusMode,
    maxReserveAgeS,
    maxMismatchRatio,
    minCoverageBps,
    reserveAgesS: {
      primary: primaryAgeS,
      secondary: secondaryAgeS,
    },
    reserveStale,
    reserveSignatureInvalid,
    sourceMismatch,
    reserveMismatchUsd,
    reserveMismatchRatio,
    coverageBps,
    status,
    reasons,
  }
}

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return n
}

const buildActiveExport = ({ project, connectors, policy }) => {
  const primary = (connectors || []).find((c) => c && String(c.role || "").trim() === "primary") || null
  const secondary = (connectors || []).find((c) => c && String(c.role || "").trim() === "secondary") || null

  const expectedSignerPrimary = String(primary?.expectedSigner || "").trim()
  const expectedSignerSecondary = String(secondary?.expectedSigner || "").trim()
  const expectedSigner = expectedSignerPrimary || expectedSignerSecondary || ""

  const maxReserveAgeS =
    policy?.maxReserveAgeS !== undefined && policy?.maxReserveAgeS !== null && String(policy.maxReserveAgeS).trim()
      ? numberOrNull(policy.maxReserveAgeS)
      : numberOrNull(project.maxReserveAgeS)

  const maxReserveMismatchRatio =
    policy?.maxMismatchRatio !== undefined && policy?.maxMismatchRatio !== null && String(policy.maxMismatchRatio).trim()
      ? numberOrNull(policy.maxMismatchRatio)
      : numberOrNull(project.maxReserveMismatchRatio)

  const serverProject = {
    id: project.id,
    name: project.name,
    receiverAddress: project.receiverAddress,
    liabilityTokenAddress: project.liabilityTokenAddress,
    rpcUrl: project.rpcUrl,
    explorerBaseUrl: project.explorerBaseUrl,
    expectedForwarderAddress: project.expectedForwarderAddress || null,
    maxReserveAgeS,
    maxReserveMismatchRatio,
  }

  const supplyChainSelectorName = String(project?.supplyChainSelectorName || "").trim()
  const supplyLiabilityTokenAddress = String(project?.supplyLiabilityTokenAddress || "").trim()
  const attestationChainSelectorName = String(project?.chainSelectorName || "").trim()

  const workflowConfig = {
    schedule: "*/300 * * * * *",
    chainSelectorName: project.chainSelectorName,
    supplyChainSelectorName: supplyChainSelectorName || undefined,
    attestationChainSelectorName: supplyChainSelectorName ? attestationChainSelectorName : undefined,
    receiverAddress: project.receiverAddress,
    liabilityTokenAddress: project.liabilityTokenAddress,
    supplyLiabilityTokenAddress: supplyLiabilityTokenAddress || undefined,
    reserveUrlPrimary: primary?.url ? String(primary.url) : "<set-me>",
    reserveUrlSecondary: secondary?.url ? String(secondary.url) : undefined,
    reserveExpectedSignerAddress: expectedSigner || undefined,
    reserveExpectedSignerAddressPrimary: expectedSignerPrimary || undefined,
    reserveExpectedSignerAddressSecondary: expectedSignerSecondary || undefined,
    reserveConsensusMode: policy?.consensusMode ? String(policy.consensusMode) : undefined,
    reserveMaxMismatchRatio: policy?.maxMismatchRatio ? String(policy.maxMismatchRatio) : undefined,
    reserveMaxAgeS: policy?.maxReserveAgeS ? String(policy.maxReserveAgeS) : undefined,
    evmReadBlockTag: "finalized",
    evmReadFallbackToLatest: true,
    evmReadRetries: "1",
    minCoverageBps: policy?.minCoverageBps ? String(policy.minCoverageBps) : "10000",
    gasLimit: "900000",
    attestationVersion: "v2",
  }

  const bundle = {
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    server: {
      projectsJson: {
        defaultProjectId: project.id,
        projects: [serverProject],
      },
    },
    workflow: {
      configProductionJson: workflowConfig,
    },
    inputs: {
      draftProject: project,
      draftPolicy: policy,
      draftConnectors: connectors,
    },
  }

  return {
    serverProjectsJsonEntry: jsonStableStringify(serverProject),
    workflowConfigSnippet: jsonStableStringify(workflowConfig),
    workflowConfigFile: jsonStableStringify(workflowConfig),
    serverProjectsJsonFile: jsonStableStringify({ defaultProjectId: project.id, projects: [serverProject] }),
    bundleJson: jsonStableStringify(bundle),
  }
}

export default function OnboardingWizardModal({
  open,
  onClose,
  serverProjects,
  draftProjects,
  draftConnectors,
  draftPolicies,
  onSaveDraftProjects,
  onSaveDraftConnectors,
  onSaveDraftPolicies,
  onSelectProjectId,
  onPublishDrafts,
}) {
  const steps = [
    { id: "project", label: "Project" },
    { id: "connect", label: "Connect" },
    { id: "policy", label: "Policy" },
    { id: "export", label: "Go live" },
  ]

  const [stepIdx, setStepIdx] = useState(0)
  const step = steps[stepIdx]?.id || "project"

  const [templateId, setTemplateId] = useState("custom")
  const [projectIdTouched, setProjectIdTouched] = useState(false)

  const [showAdvancedProject, setShowAdvancedProject] = useState(false)
  const [showAdvancedPolicy, setShowAdvancedPolicy] = useState(false)

  const [useSecondaryFeed, setUseSecondaryFeed] = useState(true)
  const prevConsensusModeRef = useRef(null)

  const [startFrom, setStartFrom] = useState("")
  const [startFromBusy, setStartFromBusy] = useState(false)
  const [startFromError, setStartFromError] = useState("")

  const [projectForm, setProjectForm] = useState(emptyProject)
  const [connectForm, setConnectForm] = useState({
    primary: { name: "Primary reserve feed", url: "", expectedSigner: "" },
    secondary: { name: "Secondary reserve feed", url: "", expectedSigner: "" },
  })
  const [policyForm, setPolicyForm] = useState({
    consensusMode: "require_match",
    minCoverageBps: "",
    maxReserveAgeS: "",
    maxMismatchRatio: "",
  })

  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)

  const [testBusy, setTestBusy] = useState(null)
  const [testResult, setTestResult] = useState({ primary: null, secondary: null })

  const [projectValidateBusy, setProjectValidateBusy] = useState(false)
  const [projectValidateResult, setProjectValidateResult] = useState(null)
  const [onchainSnapshot, setOnchainSnapshot] = useState(null)

  const [publishBusy, setPublishBusy] = useState(false)
  const [publishResult, setPublishResult] = useState(null)

  useEffect(() => {
    setProjectValidateResult(null)
    setOnchainSnapshot(null)
  }, [
    projectForm.chainSelectorName,
    projectForm.rpcUrl,
    projectForm.supplyChainSelectorName,
    projectForm.supplyRpcUrl,
    projectForm.receiverAddress,
    projectForm.liabilityTokenAddress,
    projectForm.supplyLiabilityTokenAddress,
    projectForm.expectedForwarderAddress,
  ])

  useEffect(() => {
    setTestResult({ primary: null, secondary: null })
  }, [connectForm.primary?.url, connectForm.primary?.expectedSigner, connectForm.secondary?.url, connectForm.secondary?.expectedSigner])

  useEffect(() => {
    if (!open) return
    setStepIdx(0)
    setTemplateId("custom")
    setProjectIdTouched(false)
    setShowAdvancedProject(false)
    setShowAdvancedPolicy(false)
    setUseSecondaryFeed(true)
    prevConsensusModeRef.current = null
    setStartFrom("")
    setStartFromBusy(false)
    setStartFromError("")
    setProjectForm({ ...emptyProject })
    setConnectForm({
      primary: { name: "Primary reserve feed", url: "", expectedSigner: "" },
      secondary: { name: "Secondary reserve feed", url: "", expectedSigner: "" },
    })
    setPolicyForm({
      consensusMode: "require_match",
      minCoverageBps: "",
      maxReserveAgeS: "",
      maxMismatchRatio: "",
    })
    setError("")
    setCopied(false)
    setTestBusy(null)
    setTestResult({ primary: null, secondary: null })

    setProjectValidateBusy(false)
    setProjectValidateResult(null)
    setOnchainSnapshot(null)

    setPublishBusy(false)
    setPublishResult(null)
  }, [open])

  const startFromOptions = useMemo(() => {
    const live = Array.isArray(serverProjects) ? serverProjects.filter((p) => p && normalizeId(p.id)) : []
    const draft = Array.isArray(draftProjects) ? draftProjects.filter((p) => p && normalizeId(p.id)) : []
    return {
      live,
      draft,
    }
  }, [serverProjects, draftProjects])

  useEffect(() => {
    if (!open) return
    if (!startFrom) return

    const [kind, pid] = String(startFrom).split(":")
    const projectId = normalizeId(pid)
    if (!projectId) return

    setStartFromError("")
    setStartFromBusy(true)

    void (async () => {
      try {
        const live = startFromOptions.live
        const draft = startFromOptions.draft

        const fromProject =
          kind === "draft"
            ? draft.find((p) => normalizeId(p?.id) === projectId) || null
            : live.find((p) => normalizeId(p?.id) === projectId) || null

        if (!fromProject) throw new Error("Source project not found")

        setTemplateId("custom")
        setProjectIdTouched(true)
        setProjectForm({ ...emptyProject, ...fromProject, id: projectId })

        let connectors = []
        let policy = null

        if (kind === "draft") {
          connectors = (Array.isArray(draftConnectors) ? draftConnectors : []).filter(
            (c) => c && normalizeId(c.projectId) === projectId
          )
          policy =
            (Array.isArray(draftPolicies) ? draftPolicies : []).find((p) => p && normalizeId(p.projectId) === projectId) || null
        } else {
          const [connectorsRes, policyRes] = await Promise.all([
            httpGetJson(`/api/connectors?projectId=${encodeURIComponent(projectId)}`, { timeoutMs: 10_000 }),
            httpGetJson(`/api/policies?projectId=${encodeURIComponent(projectId)}`, { timeoutMs: 10_000 }),
          ])
          connectors = Array.isArray(connectorsRes?.connectors) ? connectorsRes.connectors : []
          policy = policyRes?.policy || null
        }

        const primary = connectors.find((c) => c && String(c.role || "").trim() === "primary") || null
        const secondary = connectors.find((c) => c && String(c.role || "").trim() === "secondary") || null
        const hasSecondary = Boolean(String(secondary?.url || "").trim())

        setUseSecondaryFeed(hasSecondary)
        setConnectForm({
          primary: {
            name: String(primary?.name || "Primary reserve feed"),
            url: String(primary?.url || ""),
            expectedSigner: String(primary?.expectedSigner || ""),
          },
          secondary: {
            name: String(secondary?.name || "Secondary reserve feed"),
            url: String(secondary?.url || ""),
            expectedSigner: String(secondary?.expectedSigner || ""),
          },
        })

        setPolicyForm({
          consensusMode: String(policy?.consensusMode || "require_match"),
          minCoverageBps: asText(policy?.minCoverageBps).trim(),
          maxReserveAgeS: asText(policy?.maxReserveAgeS).trim(),
          maxMismatchRatio: asText(policy?.maxMismatchRatio).trim(),
        })

        setTestResult({ primary: null, secondary: null })
      } catch (err) {
        setStartFromError(String(err?.message || err))
      } finally {
        setStartFromBusy(false)
      }
    })()
  }, [open, startFrom, startFromOptions, draftConnectors, draftPolicies])

  useEffect(() => {
    const tpl = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0]
    if (!tpl) return

    setProjectForm((s) => {
      const next = { ...s }
      for (const [k, v] of Object.entries(tpl.project || {})) {
        if (String(next?.[k] || "").trim()) continue
        next[k] = v
      }
      return next
    })

    setPolicyForm((s) => {
      const next = { ...s }
      for (const [k, v] of Object.entries(tpl.policy || {})) {
        if (String(next?.[k] || "").trim()) continue
        next[k] = v
      }
      return next
    })
  }, [templateId])

  useEffect(() => {
    if (useSecondaryFeed) {
      if (policyForm.consensusMode === "primary_only" && prevConsensusModeRef.current) {
        const next = String(prevConsensusModeRef.current || "").trim()
        if (next && next !== "primary_only") {
          setPolicyForm((s) => ({ ...s, consensusMode: next }))
        }
      }
      return
    }

    if (policyForm.consensusMode && policyForm.consensusMode !== "primary_only") {
      prevConsensusModeRef.current = policyForm.consensusMode
    }
    setPolicyForm((s) => ({ ...s, consensusMode: "primary_only" }))
    setConnectForm((s) => ({
      ...s,
      secondary: {
        ...s.secondary,
        url: "",
        expectedSigner: "",
      },
    }))
    setTestResult((s) => ({ ...s, secondary: null }))
  }, [useSecondaryFeed, policyForm.consensusMode])

  const draftProjectId = normalizeId(projectForm.id)

  const localConnectors = useMemo(() => {
    const pid = normalizeId(projectForm.id)
    if (!pid) return []

    const primary = {
      id: normalizeConnectorId("primary"),
      projectId: pid,
      type: "http_reserve",
      name: String(connectForm.primary?.name || "").trim(),
      role: "primary",
      url: String(connectForm.primary?.url || "").trim(),
      expectedSigner: String(connectForm.primary?.expectedSigner || "").trim(),
    }

    const secondary = {
      id: normalizeConnectorId("secondary"),
      projectId: pid,
      type: "http_reserve",
      name: String(connectForm.secondary?.name || "").trim(),
      role: "secondary",
      url: String(connectForm.secondary?.url || "").trim(),
      expectedSigner: String(connectForm.secondary?.expectedSigner || "").trim(),
    }

    const arr = useSecondaryFeed ? [primary, secondary] : [primary]
    return arr.filter((c) => c.url)
  }, [connectForm, projectForm.id, useSecondaryFeed])

  const localPolicy = useMemo(() => {
    const pid = normalizeId(projectForm.id)
    if (!pid) return null

    return {
      projectId: pid,
      consensusMode: policyForm.consensusMode || "require_match",
      minCoverageBps: asText(policyForm.minCoverageBps).trim(),
      maxReserveAgeS: asText(policyForm.maxReserveAgeS).trim(),
      maxMismatchRatio: asText(policyForm.maxMismatchRatio).trim(),
      updatedAt: Date.now(),
    }
  }, [policyForm, projectForm.id])

  const activeExport = useMemo(() => {
    const pid = normalizeId(projectForm.id)
    if (!pid) return null

    const cleanProject = {
      ...projectForm,
      id: normalizeId(projectForm.id),
      name: String(projectForm.name || "").trim(),
      symbol: String(projectForm.symbol || "").trim(),
      chainSelectorName: String(projectForm.chainSelectorName || "").trim(),
      rpcUrl: String(projectForm.rpcUrl || "").trim(),
      supplyChainSelectorName: String(projectForm.supplyChainSelectorName || "").trim(),
      supplyRpcUrl: String(projectForm.supplyRpcUrl || "").trim(),
      explorerBaseUrl: String(projectForm.explorerBaseUrl || "").trim(),
      receiverAddress: String(projectForm.receiverAddress || "").trim(),
      liabilityTokenAddress: String(projectForm.liabilityTokenAddress || "").trim(),
      supplyLiabilityTokenAddress: String(projectForm.supplyLiabilityTokenAddress || "").trim(),
      expectedForwarderAddress: String(projectForm.expectedForwarderAddress || "").trim(),
      maxReserveAgeS: asText(projectForm.maxReserveAgeS).trim(),
      maxReserveMismatchRatio: asText(projectForm.maxReserveMismatchRatio).trim(),
    }

    return buildActiveExport({
      project: cleanProject,
      connectors: localConnectors,
      policy: localPolicy,
    })
  }, [localConnectors, localPolicy, projectForm])

  const copy = async (text) => {
    try {
      if (!navigator?.clipboard?.writeText) return
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      return
    }
  }

  const validateProject = () => {
    const id = normalizeId(projectForm.id)
    if (!id) return "Project ID is required"
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
      return "Project ID must be 2-63 chars: lowercase letters, numbers, hyphens"
    }
    if (!String(projectForm.name || "").trim()) return "Project name is required"
    if (!String(projectForm.chainSelectorName || "").trim()) return "Chain selector is required"
    if (!String(projectForm.receiverAddress || "").trim()) return "Receiver address is required"
    if (!String(projectForm.liabilityTokenAddress || "").trim()) return "Liability token address is required"
    if (!String(projectForm.rpcUrl || "").trim()) return "RPC URL is required"
    if (!String(projectForm.explorerBaseUrl || "").trim()) return "Explorer base URL is required"

    const supplyChainSelectorName = String(projectForm.supplyChainSelectorName || "").trim()
    const supplyRpcUrl = String(projectForm.supplyRpcUrl || "").trim()
    const supplyLiabilityTokenAddress = String(projectForm.supplyLiabilityTokenAddress || "").trim()

    if (supplyLiabilityTokenAddress && !isAddress(supplyLiabilityTokenAddress)) {
      return "Supply liability token address is invalid"
    }

    const attestationChainSelectorName = String(projectForm.chainSelectorName || "").trim()
    const supplyDiffers =
      supplyChainSelectorName &&
      attestationChainSelectorName &&
      supplyChainSelectorName.toLowerCase() !== attestationChainSelectorName.toLowerCase()

    if (supplyDiffers && !supplyRpcUrl) {
      return "Supply RPC URL is required when supply chain differs"
    }

    return ""
  }

  const validateConnectors = () => {
    if (!draftProjectId) return "Create the project first"

    const primaryUrl = String(connectForm.primary?.url || "").trim()
    if (!primaryUrl) return "Primary reserve feed URL is required"

    const primaryName = String(connectForm.primary?.name || "").trim()
    if (!primaryName) return "Primary reserve feed name is required"

    if (!testResult?.primary) return "Run the primary Test before continuing"
    if (testResult?.primary?.ok !== true) return "Primary test must pass before continuing"

    if (useSecondaryFeed) {
      const secondaryUrl = String(connectForm.secondary?.url || "").trim()
      if (!secondaryUrl) return "Secondary reserve feed URL is required"

      const secondaryName = String(connectForm.secondary?.name || "").trim()
      if (!secondaryName) return "Secondary reserve feed name is required"

      if (!testResult?.secondary) return "Run the secondary Test before continuing"
      if (testResult?.secondary?.ok !== true) return "Secondary test must pass before continuing"
    }

    return ""
  }

  const validatePolicy = () => {
    if (!draftProjectId) return "Create the project first"

    if (
      policyForm.consensusMode !== "primary_only" &&
      policyForm.consensusMode !== "require_match" &&
      policyForm.consensusMode !== "conservative_min"
    ) {
      return "Consensus mode is invalid"
    }

    if (String(policyForm.minCoverageBps || "").trim()) {
      const n = Number(policyForm.minCoverageBps)
      if (!Number.isFinite(n)) return "Min coverage bps must be a number"
    }

    if (String(policyForm.maxReserveAgeS || "").trim()) {
      const n = Number(policyForm.maxReserveAgeS)
      if (!Number.isFinite(n) || n < 0) return "Max reserve age must be a non-negative number"
    }

    if (String(policyForm.maxMismatchRatio || "").trim()) {
      const n = Number(policyForm.maxMismatchRatio)
      if (!Number.isFinite(n) || n < 0) return "Max mismatch ratio must be a non-negative number"
    }

    return ""
  }

  const persistProject = () => {
    if (typeof onSaveDraftProjects !== "function") return

    const clean = {
      ...projectForm,
      id: normalizeId(projectForm.id),
      name: String(projectForm.name || "").trim(),
      symbol: String(projectForm.symbol || "").trim(),
      chainSelectorName: String(projectForm.chainSelectorName || "").trim(),
      rpcUrl: String(projectForm.rpcUrl || "").trim(),
      supplyChainSelectorName: String(projectForm.supplyChainSelectorName || "").trim(),
      supplyRpcUrl: String(projectForm.supplyRpcUrl || "").trim(),
      explorerBaseUrl: String(projectForm.explorerBaseUrl || "").trim(),
      receiverAddress: String(projectForm.receiverAddress || "").trim(),
      liabilityTokenAddress: String(projectForm.liabilityTokenAddress || "").trim(),
      supplyLiabilityTokenAddress: String(projectForm.supplyLiabilityTokenAddress || "").trim(),
      expectedForwarderAddress: String(projectForm.expectedForwarderAddress || "").trim(),
      maxReserveAgeS: asText(projectForm.maxReserveAgeS).trim(),
      maxReserveMismatchRatio: asText(projectForm.maxReserveMismatchRatio).trim(),
    }

    const prev = Array.isArray(draftProjects) ? draftProjects : []
    const rest = prev.filter((p) => normalizeId(p?.id) !== clean.id)
    const next = [...rest, clean].sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")))
    onSaveDraftProjects(next)
    if (typeof onSelectProjectId === "function") onSelectProjectId(clean.id)
  }

  const persistConnectors = () => {
    if (typeof onSaveDraftConnectors !== "function") return

    const pid = normalizeId(projectForm.id)
    const prev = Array.isArray(draftConnectors) ? draftConnectors : []
    const rest = prev.filter((c) => normalizeId(c?.projectId) !== pid)

    const withTests = localConnectors.map((c) => {
      const key = String(c.role || "") === "primary" ? "primary" : "secondary"
      const r = testResult?.[key] || null
      if (!r) return c
      return {
        ...c,
        lastTestedAt: r.at,
        lastTestOk: Boolean(r.ok),
        lastTestMessage: String(r.message || ""),
      }
    })

    onSaveDraftConnectors([...rest, ...withTests])
  }

  const persistPolicy = () => {
    if (typeof onSaveDraftPolicies !== "function") return

    const pid = normalizeId(projectForm.id)
    const clean = {
      projectId: pid,
      consensusMode: policyForm.consensusMode || "require_match",
      minCoverageBps: asText(policyForm.minCoverageBps).trim(),
      maxReserveAgeS: asText(policyForm.maxReserveAgeS).trim(),
      maxMismatchRatio: asText(policyForm.maxMismatchRatio).trim(),
      updatedAt: Date.now(),
    }

    const prev = Array.isArray(draftPolicies) ? draftPolicies : []
    const rest = prev.filter((p) => normalizeId(p?.projectId) !== pid)
    onSaveDraftPolicies([...rest, clean])
  }

  const validateProjectOnchain = async () => {
    const rpcUrl = String(projectForm.rpcUrl || "").trim()
    const chain = resolveChain(projectForm.chainSelectorName)
    const supplyRpcUrl = String(projectForm.supplyRpcUrl || "").trim() || rpcUrl
    const supplyChain = resolveChain(projectForm.supplyChainSelectorName || projectForm.chainSelectorName)
    const receiverAddress = String(projectForm.receiverAddress || "").trim()
    const liabilityTokenAddress = String(projectForm.liabilityTokenAddress || "").trim()
    const supplyLiabilityTokenAddress = String(projectForm.supplyLiabilityTokenAddress || "").trim() || liabilityTokenAddress
    const expectedForwarder = String(projectForm.expectedForwarderAddress || "").trim()

    if (!rpcUrl) throw new Error("RPC URL is required")
    if (!receiverAddress || !isAddress(receiverAddress)) throw new Error("Receiver address is invalid")
    if (!liabilityTokenAddress || !isAddress(liabilityTokenAddress)) throw new Error("Liability token address is invalid")
    if (supplyLiabilityTokenAddress && !isAddress(supplyLiabilityTokenAddress)) throw new Error("Supply token address is invalid")

    const client = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 15_000 }),
    })

    const supplyClient =
      supplyRpcUrl === rpcUrl && supplyChain?.id === chain?.id
        ? client
        : createPublicClient({
            chain: supplyChain,
            transport: http(supplyRpcUrl, { timeout: 15_000 }),
          })

    const [blockNumber, receiverState, tokenEnforcementState, supplyTotalSupply] = await Promise.all([
      client.getBlockNumber(),
      Promise.all([
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "lastCoverageBps" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "minCoverageBps" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "mintingPaused" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "owner" }),
        client.readContract({ address: receiverAddress, abi: receiverAbi, functionName: "getForwarderAddress" }),
      ]),
      Promise.all([
        client.readContract({ address: liabilityTokenAddress, abi: tokenAbi, functionName: "mintingEnabled" }),
      ]),
      supplyClient.readContract({ address: supplyLiabilityTokenAddress, abi: tokenAbi, functionName: "totalSupply" }),
    ])

    const [lastCoverageBps, minCoverageBps, mintingPaused, receiverOwner, forwarderAddress] = receiverState
    const [mintingEnabled] = tokenEnforcementState

    const forwarderSet = Boolean(forwarderAddress) && normalizeAddress(forwarderAddress) !== ZERO_ADDRESS
    const hookWired = forwarderSet
    const forwarderMatchesExpected = expectedForwarder
      ? normalizeAddress(forwarderAddress) === normalizeAddress(expectedForwarder)
      : null

    return {
      blockNumber: blockNumber.toString(),
      receiverAddress: normalizeAddress(receiverAddress),
      liabilityTokenAddress: normalizeAddress(liabilityTokenAddress),
      supplyChainSelectorName: String(projectForm.supplyChainSelectorName || "").trim() || null,
      supplyRpcUrl: supplyRpcUrl === rpcUrl ? null : supplyRpcUrl,
      supplyLiabilityTokenAddress:
        normalizeAddress(supplyLiabilityTokenAddress) === normalizeAddress(liabilityTokenAddress)
          ? null
          : normalizeAddress(supplyLiabilityTokenAddress),
      error: "",
      receiver: {
        lastCoverageBps: lastCoverageBps.toString(),
        minCoverageBps: minCoverageBps.toString(),
        mintingPaused: Boolean(mintingPaused),
        owner: receiverOwner,
        forwarderAddress,
      },
      token: {
        totalSupply: supplyTotalSupply.toString(),
        mintingEnabled: Boolean(mintingEnabled),
      },
      enforcement: {
        hookWired,
        forwarderSet,
        expectedForwarder: expectedForwarder || null,
        forwarderMatchesExpected,
      },
    }
  }

  const runProjectValidation = async ({ bubbleError } = {}) => {
    setProjectValidateBusy(true)
    setProjectValidateResult(null)
    setOnchainSnapshot(null)

    try {
      const onchain = await validateProjectOnchain()
      setProjectValidateResult({
        at: Date.now(),
        ok: true,
        message: `ok block=${onchain.blockNumber} coverage=${onchain.receiver.lastCoverageBps} min=${onchain.receiver.minCoverageBps}`,
      })
      setOnchainSnapshot(onchain)
      return { ok: true, onchain }
    } catch (err) {
      const message = String(err?.message || err)
      setProjectValidateResult({ at: Date.now(), ok: false, message })
      if (bubbleError) setError(message)
      return { ok: false, message }
    } finally {
      setProjectValidateBusy(false)
    }
  }

  const onNext = async () => {
    setError("")

    if (step === "project") {
      const msg = validateProject()
      if (msg) {
        setError(msg)
        return
      }

      const onchainRes = await runProjectValidation({ bubbleError: true })
      if (!onchainRes.ok) return

      persistProject()
      setStepIdx((s) => Math.min(steps.length - 1, s + 1))
      return
    }

    if (step === "connect") {
      const msg = validateConnectors()
      if (msg) {
        setError(msg)
        return
      }
      persistConnectors()
      setStepIdx((s) => Math.min(steps.length - 1, s + 1))
      return
    }

    if (step === "policy") {
      const msg = validatePolicy()
      if (msg) {
        setError(msg)
        return
      }
      persistPolicy()
      setStepIdx((s) => Math.min(steps.length - 1, s + 1))
      return
    }

    if (step === "export") {
      if (draftProjectId && typeof onSelectProjectId === "function") onSelectProjectId(draftProjectId)
      if (typeof onClose === "function") onClose()
    }
  }

  const onBack = () => {
    setError("")
    setStepIdx((s) => Math.max(0, s - 1))
  }

  const onPublish = async () => {
    if (!draftProjectId) return
    if (typeof onPublishDrafts !== "function") {
      setError("Publish is not available")
      return
    }

    const ok = window.confirm("Publish drafts to live configuration now?")
    if (!ok) return

    setError("")
    setPublishBusy(true)
    setPublishResult(null)
    try {
      await onPublishDrafts(draftProjectId)
      setPublishResult({ at: Date.now(), ok: true, message: "Published" })
      if (typeof onClose === "function") onClose()
    } catch (err) {
      const msg = String(err?.message || err)
      setPublishResult({ at: Date.now(), ok: false, message: msg })
      setError(msg)
    } finally {
      setPublishBusy(false)
    }
  }

  const testConnection = async (key) => {
    const cfg = key === "primary" ? connectForm.primary : connectForm.secondary
    const url = String(cfg?.url || "").trim()
    if (!url) return

    setTestBusy(key)

    const startedAt = Date.now()

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`HTTP ${res.status}${text ? ` ${text}` : ""}`)
      }

      const data = await res.json()
      const timestamp = data?.timestamp
      const reserveUsd = data?.reserveUsd
      const navUsd = data?.navUsd
      const source = data?.source
      const signer = data?.signer
      const signature = data?.signature

      const parsedTimestamp = typeof timestamp === "number" ? timestamp : Number(timestamp)

      if (!Number.isFinite(parsedTimestamp) || reserveUsd === null || reserveUsd === undefined || reserveUsd === "") {
        throw new Error("Response missing required fields (timestamp, reserveUsd)")
      }

      if (source !== undefined && source !== null && !String(source).trim()) {
        throw new Error("Response field source must be a non-empty string")
      }

      const parsedReserve = {
        timestamp: parsedTimestamp,
        reserveUsd,
        navUsd,
        source: source || (key === "primary" ? "primary" : "secondary"),
        signer,
        signature,
      }

      const expectedSigner = String(cfg?.expectedSigner || "").trim()

      const sig = await verifyReserveSignature({ reserve: parsedReserve, expectedSigner })

      if (expectedSigner && sig.signatureValid !== true) {
        throw new Error(sig.signatureError || "Signature verification failed")
      }

      const latencyMs = Date.now() - startedAt
      const ageS = Math.max(0, Math.floor(Date.now() / 1000) - parsedTimestamp)

      const signerLine = signer ? ` signer=${signer}` : ""
      const sigLine = expectedSigner ? ` sig=${sig.signatureValid ? "ok" : "bad"}` : ""

      setTestResult((s) => ({
        ...s,
        [key]: {
          at: Date.now(),
          ok: true,
          latencyMs,
          ageS,
          reserve: {
            ...parsedReserve,
            signatureValid: sig.signatureValid,
            recoveredSigner: sig.recoveredSigner,
            signatureError: sig.signatureError,
          },
          message: `ok reserveUsd=${reserveUsd}${navUsd ? ` navUsd=${navUsd}` : ""} ts=${parsedTimestamp} age=${ageS}s latency=${latencyMs}ms${signerLine}${sigLine}`,
        },
      }))
    } catch (err) {
      const latencyMs = Date.now() - startedAt
      setTestResult((s) => ({
        ...s,
        [key]: {
          at: Date.now(),
          ok: false,
          latencyMs,
          ageS: null,
          reserve: null,
          message: String(err?.message || err),
        },
      }))
    } finally {
      clearTimeout(timeout)
      setTestBusy(null)
    }
  }

  if (!open) return null

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div>
            <h2 className="modal-title">Onboarding Wizard</h2>
            <p className="modal-subtitle">Create a draft project, connect sources, configure policy, then export for deployment</p>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modal-body">
          <div className="wizard-steps" aria-label="Onboarding steps">
            {steps.map((s, idx) => {
              const state = idx === stepIdx ? "active" : idx < stepIdx ? "done" : "todo"
              return (
                <div key={s.id} className={`wizard-step ${state}`}>
                  <div className="wizard-step-dot" />
                  <div className="wizard-step-label">{s.label}</div>
                </div>
              )
            })}
          </div>

          {step === "project" && (
            <div className="form">
              <div className="form-grid">
                <label className="field span-2">
                  <span className="field-label">Start from existing (optional)</span>
                  <select
                    className="text-input"
                    value={startFrom}
                    onChange={(e) => {
                      const v = String(e.target.value || "")
                      setStartFrom(v)
                      if (!v) {
                        setTemplateId("custom")
                        setProjectIdTouched(false)
                        setUseSecondaryFeed(true)
                        prevConsensusModeRef.current = null
                        setProjectForm({ ...emptyProject })
                        setConnectForm({
                          primary: { name: "Primary reserve feed", url: "", expectedSigner: "" },
                          secondary: { name: "Secondary reserve feed", url: "", expectedSigner: "" },
                        })
                        setPolicyForm({
                          consensusMode: "require_match",
                          minCoverageBps: "",
                          maxReserveAgeS: "",
                          maxMismatchRatio: "",
                        })
                        setTestResult({ primary: null, secondary: null })
                        setStartFromError("")
                      }
                    }}
                    disabled={startFromBusy}
                  >
                    <option value="">None</option>
                    <optgroup label="Live projects">
                      {startFromOptions.live.map((p) => (
                        <option key={`live:${normalizeId(p?.id)}`} value={`live:${normalizeId(p?.id)}`}>
                          {normalizeId(p?.id) || "(missing id)"}{p?.name ? ` — ${p.name}` : ""}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Draft projects">
                      {startFromOptions.draft.map((p) => (
                        <option key={`draft:${normalizeId(p?.id)}`} value={`draft:${normalizeId(p?.id)}`}>
                          {normalizeId(p?.id) || "(missing id)"}{p?.name ? ` — ${p.name}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>

                {startFromError && <div className="form-error span-2">{startFromError}</div>}

                <label className="field span-2">
                  <span className="field-label">Template</span>
                  <select
                    className="text-input"
                    value={templateId}
                    onChange={(e) => setTemplateId(e.target.value)}
                    disabled={Boolean(startFrom)}
                  >
                    {TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span className="field-label">Project ID</span>
                  <input
                    className="text-input"
                    value={projectForm.id}
                    onChange={(e) => {
                      setProjectIdTouched(true)
                      setProjectForm((s) => ({ ...s, id: e.target.value }))
                    }}
                    placeholder="reservewatch-sepolia"
                    disabled={Boolean(startFrom)}
                  />
                </label>

                <label className="field">
                  <span className="field-label">Name</span>
                  <input
                    className="text-input"
                    value={projectForm.name}
                    onChange={(e) => {
                      const name = e.target.value
                      setProjectForm((s) => {
                        const next = { ...s, name }
                        if (!projectIdTouched) next.id = toProjectIdSlug(name)
                        return next
                      })
                    }}
                    placeholder="My Asset"
                  />
                </label>

                <label className="field">
                  <span className="field-label">Symbol</span>
                  <input
                    className="text-input"
                    value={projectForm.symbol}
                    onChange={(e) => setProjectForm((s) => ({ ...s, symbol: e.target.value }))}
                    placeholder="RWA"
                  />
                </label>

                <label className="field">
                  <span className="field-label">Attestation chain selector</span>
                  <input
                    className="text-input"
                    value={projectForm.chainSelectorName}
                    onChange={(e) => setProjectForm((s) => ({ ...s, chainSelectorName: e.target.value }))}
                    placeholder="ethereum-testnet-sepolia"
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Attestation RPC URL</span>
                  <input
                    className="text-input"
                    value={projectForm.rpcUrl}
                    onChange={(e) => setProjectForm((s) => ({ ...s, rpcUrl: e.target.value }))}
                    placeholder="https://..."
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Explorer base URL</span>
                  <input
                    className="text-input"
                    value={projectForm.explorerBaseUrl}
                    onChange={(e) => setProjectForm((s) => ({ ...s, explorerBaseUrl: e.target.value }))}
                    placeholder="https://sepolia.etherscan.io"
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Receiver address</span>
                  <input
                    className="text-input"
                    value={projectForm.receiverAddress}
                    onChange={(e) => setProjectForm((s) => ({ ...s, receiverAddress: e.target.value }))}
                    placeholder="0x..."
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Liability token address</span>
                  <input
                    className="text-input"
                    value={projectForm.liabilityTokenAddress}
                    onChange={(e) => setProjectForm((s) => ({ ...s, liabilityTokenAddress: e.target.value }))}
                    placeholder="0x..."
                  />
                </label>

                <div className="form-actions" style={{ justifyContent: "flex-start" }}>
                  <button className="btn btn-ghost" type="button" onClick={() => setShowAdvancedProject((s) => !s)}>
                    {showAdvancedProject ? "Hide advanced" : "Show advanced"}
                  </button>
                </div>

                {showAdvancedProject && (
                  <>
                    <label className="field">
                      <span className="field-label">Supply chain selector (optional)</span>
                      <input
                        className="text-input"
                        value={projectForm.supplyChainSelectorName}
                        onChange={(e) => setProjectForm((s) => ({ ...s, supplyChainSelectorName: e.target.value }))}
                        placeholder="leave blank to use attestation chain"
                      />
                    </label>

                    <label className="field span-2">
                      <span className="field-label">Supply RPC URL (optional)</span>
                      <input
                        className="text-input"
                        value={projectForm.supplyRpcUrl}
                        onChange={(e) => setProjectForm((s) => ({ ...s, supplyRpcUrl: e.target.value }))}
                        placeholder="leave blank to use attestation RPC"
                      />
                    </label>

                    <label className="field span-2">
                      <span className="field-label">Supply token address (optional)</span>
                      <input
                        className="text-input"
                        value={projectForm.supplyLiabilityTokenAddress}
                        onChange={(e) => setProjectForm((s) => ({ ...s, supplyLiabilityTokenAddress: e.target.value }))}
                        placeholder="leave blank to use liability token"
                      />
                    </label>

                    <label className="field span-2">
                      <span className="field-label">Expected forwarder (optional)</span>
                      <input
                        className="text-input"
                        value={projectForm.expectedForwarderAddress}
                        onChange={(e) => setProjectForm((s) => ({ ...s, expectedForwarderAddress: e.target.value }))}
                        placeholder="0x..."
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Max reserve age (s)</span>
                      <input
                        className="text-input"
                        value={projectForm.maxReserveAgeS}
                        onChange={(e) => setProjectForm((s) => ({ ...s, maxReserveAgeS: e.target.value }))}
                        placeholder="3600"
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Max mismatch ratio</span>
                      <input
                        className="text-input"
                        value={projectForm.maxReserveMismatchRatio}
                        onChange={(e) => setProjectForm((s) => ({ ...s, maxReserveMismatchRatio: e.target.value }))}
                        placeholder="0.02"
                      />
                    </label>
                  </>
                )}
              </div>

              <div className="form-actions">
                <button
                  className="btn btn-ok"
                  disabled={projectValidateBusy}
                  onClick={() => void runProjectValidation({ bubbleError: true })}
                >
                  {projectValidateBusy ? "Validating..." : "Validate onchain"}
                </button>
              </div>

              {projectValidateResult && (
                <div className={projectValidateResult.ok ? "wizard-test ok" : "wizard-test bad"}>
                  {projectValidateResult.ok ? "Onchain ok" : "Onchain failed"} · {projectValidateResult.message}
                </div>
              )}
            </div>
          )}

          {step === "connect" && (
            <>
              <div className="form-actions" style={{ justifyContent: "flex-start", marginBottom: 12 }}>
                <button className="btn btn-ghost" type="button" onClick={() => setUseSecondaryFeed((s) => !s)}>
                  {useSecondaryFeed ? "Disable secondary feed" : "Enable secondary feed"}
                </button>
              </div>

              <div className="modal-split">
                <div className="modal-pane">
                  <div className="pane-header">
                    <h3 className="pane-title">Primary reserve feed</h3>
                    <button
                      className="btn btn-ok"
                      disabled={!String(connectForm.primary?.url || "").trim() || testBusy === "primary"}
                      onClick={() => void testConnection("primary")}
                    >
                      {testBusy === "primary" ? "Testing..." : "Test"}
                    </button>
                  </div>

                  <div className="form">
                    <div className="form-grid">
                      <label className="field span-2">
                        <span className="field-label">Name</span>
                        <input
                          className="text-input"
                          value={connectForm.primary.name}
                          onChange={(e) =>
                            setConnectForm((s) => ({ ...s, primary: { ...s.primary, name: e.target.value } }))
                          }
                          placeholder="Primary reserve feed"
                        />
                      </label>

                      <label className="field span-2">
                        <span className="field-label">URL</span>
                        <input
                          className="text-input"
                          value={connectForm.primary.url}
                          onChange={(e) =>
                            setConnectForm((s) => ({ ...s, primary: { ...s.primary, url: e.target.value } }))
                          }
                          placeholder="https://..."
                        />
                      </label>

                      <label className="field span-2">
                        <span className="field-label">Expected signer (optional)</span>
                        <input
                          className="text-input"
                          value={connectForm.primary.expectedSigner}
                          onChange={(e) =>
                            setConnectForm((s) => ({
                              ...s,
                              primary: { ...s.primary, expectedSigner: e.target.value },
                            }))
                          }
                          placeholder="0x..."
                        />
                      </label>
                    </div>

                    {testResult.primary && (
                      <div className={testResult.primary.ok ? "wizard-test ok" : "wizard-test bad"}>
                        {testResult.primary.ok ? "Test ok" : "Test failed"} · {testResult.primary.message}
                      </div>
                    )}
                  </div>
                </div>

                {useSecondaryFeed && (
                  <div className="modal-pane">
                    <div className="pane-header">
                      <h3 className="pane-title">Secondary reserve feed</h3>
                      <button
                        className="btn btn-ok"
                        disabled={!String(connectForm.secondary?.url || "").trim() || testBusy === "secondary"}
                        onClick={() => void testConnection("secondary")}
                      >
                        {testBusy === "secondary" ? "Testing..." : "Test"}
                      </button>
                    </div>

                    <div className="form">
                      <div className="form-grid">
                        <label className="field span-2">
                          <span className="field-label">Name</span>
                          <input
                            className="text-input"
                            value={connectForm.secondary.name}
                            onChange={(e) =>
                              setConnectForm((s) => ({ ...s, secondary: { ...s.secondary, name: e.target.value } }))
                            }
                            placeholder="Secondary reserve feed"
                          />
                        </label>

                        <label className="field span-2">
                          <span className="field-label">URL</span>
                          <input
                            className="text-input"
                            value={connectForm.secondary.url}
                            onChange={(e) =>
                              setConnectForm((s) => ({ ...s, secondary: { ...s.secondary, url: e.target.value } }))
                            }
                            placeholder="https://..."
                          />
                        </label>

                        <label className="field span-2">
                          <span className="field-label">Expected signer (optional)</span>
                          <input
                            className="text-input"
                            value={connectForm.secondary.expectedSigner}
                            onChange={(e) =>
                              setConnectForm((s) => ({
                                ...s,
                                secondary: { ...s.secondary, expectedSigner: e.target.value },
                              }))
                            }
                            placeholder="0x..."
                          />
                        </label>
                      </div>

                      {testResult.secondary && (
                        <div className={testResult.secondary.ok ? "wizard-test ok" : "wizard-test bad"}>
                          {testResult.secondary.ok ? "Test ok" : "Test failed"} · {testResult.secondary.message}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {step === "policy" && (
            <div className="form">
              <div className="form-grid">
                <label className="field span-2">
                  <span className="field-label">Consensus mode</span>
                  <select
                    className="text-input"
                    value={policyForm.consensusMode}
                    disabled={!useSecondaryFeed}
                    onChange={(e) => setPolicyForm((s) => ({ ...s, consensusMode: e.target.value }))}
                  >
                    <option value="primary_only">Primary only</option>
                    <option value="require_match">Require match</option>
                    <option value="conservative_min">Conservative min</option>
                  </select>
                </label>

                <label className="field">
                  <span className="field-label">Min coverage bps</span>
                  <input
                    className="text-input"
                    value={policyForm.minCoverageBps}
                    onChange={(e) => setPolicyForm((s) => ({ ...s, minCoverageBps: e.target.value }))}
                    placeholder="10000"
                  />
                </label>

                <div className="form-actions" style={{ justifyContent: "flex-start" }}>
                  <button className="btn btn-ghost" type="button" onClick={() => setShowAdvancedPolicy((s) => !s)}>
                    {showAdvancedPolicy ? "Hide advanced" : "Show advanced"}
                  </button>
                </div>

                {showAdvancedPolicy && (
                  <>
                    <label className="field">
                      <span className="field-label">Max reserve age (s)</span>
                      <input
                        className="text-input"
                        value={policyForm.maxReserveAgeS}
                        onChange={(e) => setPolicyForm((s) => ({ ...s, maxReserveAgeS: e.target.value }))}
                        placeholder={asText(projectForm.maxReserveAgeS) || "120"}
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Max mismatch ratio</span>
                      <input
                        className="text-input"
                        value={policyForm.maxMismatchRatio}
                        onChange={(e) => setPolicyForm((s) => ({ ...s, maxMismatchRatio: e.target.value }))}
                        placeholder={asText(projectForm.maxReserveMismatchRatio) || "0.01"}
                      />
                    </label>
                  </>
                )}
              </div>

              {(() => {
                const reserves = {
                  primary: testResult?.primary?.reserve || null,
                  secondary: testResult?.secondary?.reserve || null,
                }

                if (!draftProjectId) return null
                if (!reserves.primary && !reserves.secondary) return null

                const derived = computeDerivedPreview({
                  reserves,
                  onchain: onchainSnapshot,
                  project: projectForm,
                  policy: localPolicy,
                })

                return (
                  <div className="card" style={{ marginTop: 12 }}>
                    <div className="detail-header" style={{ marginBottom: 8 }}>
                      <div>
                        <div className="section-title">Preview</div>
                        <div className="tab-subtitle">Based on the last source tests + onchain validation</div>
                      </div>
                      <StatusPill status={derived.status} />
                    </div>

                    {derived?.reasons?.length ? (
                      <div className="empty-state">Reasons: {derived.reasons.join(", ")}</div>
                    ) : (
                      <div className="empty-state">No reasons</div>
                    )}
                  </div>
                )
              })()}
            </div>
          )}

          {step === "export" && (
            <div className="export">
              <div className="card" style={{ marginBottom: 12 }}>
                <div className="section-title">Publish</div>
                <div className="tab-subtitle">Promote this draft configuration to live.</div>
                <div className="form-actions" style={{ marginTop: 8, justifyContent: "flex-start" }}>
                  <button
                    className="btn btn-ok"
                    disabled={!draftProjectId || publishBusy || typeof onPublishDrafts !== "function"}
                    onClick={() => void onPublish()}
                  >
                    {publishBusy ? "Publishing..." : "Publish draft to live"}
                  </button>
                </div>

                {publishResult && (
                  <div className={publishResult.ok ? "wizard-test ok" : "wizard-test bad"}>
                    {publishResult.ok ? "Publish ok" : "Publish failed"} · {publishResult.message}
                  </div>
                )}
              </div>

              <div className="card" style={{ marginBottom: 12 }}>
                <div className="section-title">Monitoring</div>
                <div className="tab-subtitle">Draft projects are monitored client-side once selected.</div>
                <div className="form-actions" style={{ marginTop: 8 }}>
                  <button
                    className="btn btn-ok"
                    disabled={!draftProjectId}
                    onClick={() => {
                      if (draftProjectId && typeof onSelectProjectId === "function") onSelectProjectId(draftProjectId)
                    }}
                  >
                    Select project & start monitor
                  </button>
                </div>
              </div>

              {!activeExport ? (
                <div className="empty-state">Complete the previous steps to generate an export bundle.</div>
              ) : (
                <>
                  <div className="export-section">
                    <div className="export-header">
                      <div className="export-title">Server projects.json (file)</div>
                      <div className="export-actions">
                        <button className="btn btn-ghost" onClick={() => void copy(activeExport.serverProjectsJsonFile)}>
                          {copied ? "Copied" : "Copy"}
                        </button>
                        <button
                          className="btn btn-primary"
                          onClick={() => downloadText("projects.json", activeExport.serverProjectsJsonFile)}
                        >
                          Download
                        </button>
                      </div>
                    </div>
                    <pre className="code-block">{activeExport.serverProjectsJsonFile}</pre>
                  </div>

                  <div className="export-section">
                    <div className="export-header">
                      <div className="export-title">Workflow config.production.json (file)</div>
                      <div className="export-actions">
                        <button className="btn btn-ghost" onClick={() => void copy(activeExport.workflowConfigFile)}>
                          {copied ? "Copied" : "Copy"}
                        </button>
                        <button
                          className="btn btn-primary"
                          onClick={() => downloadText("config.production.json", activeExport.workflowConfigFile)}
                        >
                          Download
                        </button>
                      </div>
                    </div>
                    <pre className="code-block">{activeExport.workflowConfigFile}</pre>
                  </div>

                  <div className="export-section">
                    <div className="export-header">
                      <div className="export-title">Export bundle (single JSON)</div>
                      <div className="export-actions">
                        <button className="btn btn-ghost" onClick={() => void copy(activeExport.bundleJson)}>
                          {copied ? "Copied" : "Copy"}
                        </button>
                        <button
                          className="btn btn-primary"
                          onClick={() => downloadText(`reservewatch-bundle-${normalizeId(projectForm.id) || "draft"}.json`, activeExport.bundleJson)}
                        >
                          Download
                        </button>
                      </div>
                    </div>
                    <pre className="code-block">{activeExport.bundleJson}</pre>
                  </div>
                </>
              )}
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="wizard-actions">
            <button className="btn btn-ghost" onClick={onBack} disabled={stepIdx === 0}>
              Back
            </button>
            <button className="btn btn-primary" onClick={onNext}>
              {step === "export" ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
