import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  createPublicClient,
  http,
  parseAbi,
  recoverMessageAddress,
} from "viem"
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon, sepolia } from "viem/chains"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const normalizeAddress = (addr) => {
  if (!addr) return ""
  return String(addr).toLowerCase()
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

const toFiniteNumber = (value) => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const asText = (value) => {
  if (value === null || value === undefined) return ""
  return String(value)
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
  const signer = reserve?.signer
  const signature = reserve?.signature

  if (!expectedSigner) {
    return {
      signatureValid: null,
      recoveredSigner: null,
      signatureError: null,
    }
  }

  if (!signer || !signature) {
    return {
      signatureValid: false,
      recoveredSigner: null,
      signatureError: "missing signer/signature",
    }
  }

  try {
    const recoveredSigner = await recoverMessageAddress({
      message: reserveMessage(reserve),
      signature,
    })

    const okRecovered = normalizeAddress(recoveredSigner) === normalizeAddress(expectedSigner)
    const okDeclared = normalizeAddress(signer) === normalizeAddress(expectedSigner)

    return {
      signatureValid: okRecovered && okDeclared,
      recoveredSigner,
      signatureError: null,
    }
  } catch (err) {
    return {
      signatureValid: false,
      recoveredSigner: null,
      signatureError: String(err?.message || err),
    }
  }
}

const fetchReserve = async ({ url, fallbackSource, expectedSigner }) => {
  if (!url) {
    return {
      ok: false,
      error: "missing url",
      reserve: null,
    }
  }

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

    const parsed = {
      timestamp: typeof data?.timestamp === "number" ? data.timestamp : Number(data?.timestamp),
      reserveUsd: data?.reserveUsd,
      navUsd: data?.navUsd,
      source: data?.source || fallbackSource || "unknown",
      signer: data?.signer,
      signature: data?.signature,
    }

    if (!Number.isFinite(parsed.timestamp) || !parsed.reserveUsd) {
      throw new Error("Response missing required fields (timestamp, reserveUsd)")
    }

    const sig = await verifyReserveSignature({ reserve: parsed, expectedSigner })

    return {
      ok: true,
      error: "",
      reserve: {
        ...parsed,
        signatureValid: sig.signatureValid,
        recoveredSigner: sig.recoveredSigner,
        signatureError: sig.signatureError,
      },
    }
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      reserve: null,
    }
  } finally {
    clearTimeout(timeout)
  }
}

const getOnchainStatus = async ({ project }) => {
  const rpcUrl = project?.rpcUrl || ""
  const chain = resolveChain(project?.chainSelectorName)

  const receiverAddress = String(project?.receiverAddress || "").toLowerCase()
  const liabilityTokenAddress = String(project?.liabilityTokenAddress || "").toLowerCase()

  if (!rpcUrl || !receiverAddress || !liabilityTokenAddress) {
    return {
      rpcUrl,
      receiverAddress,
      liabilityTokenAddress,
      error: "missing rpc/receiver/token",
    }
  }

  const client = createPublicClient({
    chain,
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

    const hookWired = normalizeAddress(guardian) === normalizeAddress(receiverAddress)
    const forwarderSet = normalizeAddress(forwarderAddress) !== ZERO_ADDRESS
    const expectedForwarder = String(project?.expectedForwarderAddress || "").trim()
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
        mintingPaused: Boolean(mintingPaused),
        minCoverageBps: minCoverageBps.toString(),
        owner: receiverOwner,
        forwarderAddress,
      },
      token: {
        totalSupply: totalSupply.toString(),
        mintingEnabled: Boolean(mintingEnabled),
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

const computeDerived = ({ reserves, onchain, project, policy }) => {
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

const buildLinks = ({ project, onchain }) => {
  const explorerBase = project?.explorerBaseUrl || "https://sepolia.etherscan.io"
  const receiverAddress = onchain?.receiverAddress || null
  const liabilityTokenAddress = onchain?.liabilityTokenAddress || null
  const guardian = onchain?.token?.guardian
  const receiverOwner = onchain?.receiver?.owner
  const tokenOwner = onchain?.token?.owner
  const forwarderAddress = onchain?.receiver?.forwarderAddress

  return {
    explorerBase,
    receiver: receiverAddress ? `${explorerBase}/address/${receiverAddress}` : null,
    token: liabilityTokenAddress ? `${explorerBase}/address/${liabilityTokenAddress}` : null,
    guardian: guardian ? `${explorerBase}/address/${guardian}` : null,
    receiverOwner: receiverOwner ? `${explorerBase}/address/${receiverOwner}` : null,
    tokenOwner: tokenOwner ? `${explorerBase}/address/${tokenOwner}` : null,
    forwarder: forwarderAddress ? `${explorerBase}/address/${forwarderAddress}` : null,
    lastTx: null,
  }
}

const buildOperator = ({ derived }) => {
  const operator = {
    recommendedActions: [],
    flows: {
      reenableMinting: {
        guarded: true,
        how: "broadcast_healthy_attestation",
        steps: [
          "Fix underlying issue (reserves restored, data sources healthy)",
          "Run workflow with broadcast to publish a healthy attestation",
          "Verify onchain: receiver.mintingPaused=false AND token.mintingEnabled=true",
        ],
        notes: [],
      },
    },
  }

  if (derived?.status === "STALE") operator.recommendedActions.push("check_rpc_and_data_sources")
  if (derived?.reasons?.includes?.("enforcement_not_wired") || derived?.reasons?.includes?.("forwarder_not_set")) {
    operator.recommendedActions.push("fix_enforcement_wiring_roles")
  }
  if (derived?.reasons?.includes?.("reserve_source_mismatch")) operator.recommendedActions.push("investigate_source_discrepancy")
  if (derived?.reasons?.includes?.("coverage_below_threshold")) operator.recommendedActions.push("broadcast_new_attestation_after_fix")
  if (derived?.reasons?.includes?.("minting_paused") || derived?.reasons?.includes?.("minting_disabled")) {
    operator.recommendedActions.push("use_guarded_reenable_flow")
  }

  return operator
}

export default function useClientMonitor({ enabled, project, connectors, policy, pollMs }) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null)

  const enabledRef = useRef(Boolean(enabled))
  const projectId = String(project?.id || "").trim()

  const connectorMap = useMemo(() => {
    const list = Array.isArray(connectors) ? connectors : []
    const primary = list.find((c) => String(c?.role || "") === "primary") || null
    const secondary = list.find((c) => String(c?.role || "") === "secondary") || null
    return { primary, secondary }
  }, [connectors])

  const tick = useCallback(async () => {
    if (!enabledRef.current) return

    setBusy(true)
    try {
      const expectedPrimary = String(connectorMap.primary?.expectedSigner || "").trim()
      const expectedSecondary = String(connectorMap.secondary?.expectedSigner || "").trim()

      const tasks = [
        fetchReserve({
          url: String(connectorMap.primary?.url || "").trim(),
          fallbackSource: String(connectorMap.primary?.id || "primary"),
          expectedSigner: expectedPrimary,
        }),
        fetchReserve({
          url: String(connectorMap.secondary?.url || "").trim(),
          fallbackSource: String(connectorMap.secondary?.id || "secondary"),
          expectedSigner: expectedSecondary,
        }),
        getOnchainStatus({ project }),
      ]

      const [primaryRes, secondaryRes, onchainRes] = await Promise.all(tasks)

      const reserves = {
        primary: primaryRes?.reserve || null,
        secondary: secondaryRes?.reserve || null,
      }

      const onchain = onchainRes || null

      const derived = computeDerived({ reserves, onchain, project, policy })
      const links = buildLinks({ project, onchain })
      const operator = buildOperator({ derived })

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

      setStatus({
        mode: "client",
        reserves,
        onchain,
        incident: null,
        derived,
        links,
        interfaces,
        operator,
      })

      const errs = [primaryRes?.error, secondaryRes?.error].filter(Boolean)
      setError(errs.length ? `Reserve source error: ${errs[0]}` : "")
      setLastUpdatedAt(Date.now())
    } catch (err) {
      setError(String(err?.message || err))
      setLastUpdatedAt(Date.now())
    } finally {
      setBusy(false)
    }
  }, [connectorMap, policy, project])

  useEffect(() => {
    enabledRef.current = Boolean(enabled)
  }, [enabled])

  useEffect(() => {
    if (!enabled || !projectId) {
      setStatus(null)
      setError("")
      setBusy(false)
      setLastUpdatedAt(null)
      return
    }

    let alive = true

    const run = async () => {
      await tick()
      if (!alive) return
      const t = setInterval(() => {
        void tick()
      }, pollMs || 8000)

      return () => clearInterval(t)
    }

    let cleanup = null
    void (async () => {
      cleanup = await run()
    })()

    return () => {
      alive = false
      if (cleanup) cleanup()
    }
  }, [enabled, pollMs, projectId, tick])

  const refresh = useCallback(async () => {
    await tick()
  }, [tick])

  return {
    status,
    error,
    busy,
    lastUpdatedAt,
    refresh,
  }
}
