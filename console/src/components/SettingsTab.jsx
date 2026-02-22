import { useCallback, useEffect, useMemo, useState } from "react"

import StatusPill from "./StatusPill"

const asText = (value) => {
  if (value === null || value === undefined || value === "") return ""
  return String(value)
}

const toFiniteNumber = (value) => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const formatMaybe = (value) => {
  if (value === null || value === undefined || value === "") return "--"
  return String(value)
}

const fetchJson = async (url, init = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs || 12000)

  try {
    const response = await fetch(url, {
      method: init.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(init.headers || {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })

    const raw = await response.text().catch(() => "")
    if (!response.ok) {
      throw new Error(raw ? `HTTP ${response.status} ${raw}` : `HTTP ${response.status}`)
    }
    if (!raw) return null
    return JSON.parse(raw)
  } finally {
    clearTimeout(timeout)
  }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const isNonZeroAddress = (value) => {
  if (!value) return false
  const addr = String(value).trim().toLowerCase()
  if (!addr) return false
  if (!addr.startsWith("0x")) return true
  return addr !== ZERO_ADDRESS
}

const computePreview = ({ status, policy }) => {
  const now = Math.floor(Date.now() / 1000)

  const reserves = status?.reserves || {}
  const onchain = status?.onchain || {}
  const incident = status?.incident || null
  const derived = status?.derived || {}

  const consensusMode = policy?.consensusMode || "require_match"
  const maxReserveAgeS = toFiniteNumber(policy?.maxReserveAgeS)
  const maxMismatchRatio = toFiniteNumber(policy?.maxMismatchRatio)
  const minCoverageBpsOverride = toFiniteNumber(policy?.minCoverageBps)

  const primaryTs = reserves?.primary?.timestamp
  const secondaryTs = reserves?.secondary?.timestamp

  const primaryAgeS = typeof primaryTs === "number" ? now - primaryTs : null
  const secondaryAgeS = typeof secondaryTs === "number" ? now - secondaryTs : null

  const reserveStale = (() => {
    if (!Number.isFinite(maxReserveAgeS)) return false
    if (consensusMode === "primary_only") {
      return typeof primaryAgeS === "number" ? primaryAgeS > maxReserveAgeS : false
    }
    return (
      (typeof primaryAgeS === "number" && primaryAgeS > maxReserveAgeS) ||
      (typeof secondaryAgeS === "number" && secondaryAgeS > maxReserveAgeS)
    )
  })()

  const reserveSignatureInvalid =
    Boolean(derived?.reserveSignatureInvalid) ||
    (Array.isArray(derived?.reasons) && derived.reasons.includes("reserve_signature_invalid"))

  const primaryReserveUsd = toFiniteNumber(reserves?.primary?.reserveUsd)
  const secondaryReserveUsd = toFiniteNumber(reserves?.secondary?.reserveUsd)

  let reserveMismatchUsd = null
  let reserveMismatchRatio = null
  let sourceMismatch = false

  if (consensusMode !== "primary_only" && typeof primaryReserveUsd === "number" && typeof secondaryReserveUsd === "number") {
    reserveMismatchUsd = Math.abs(primaryReserveUsd - secondaryReserveUsd)
    const denom = Math.max(primaryReserveUsd, secondaryReserveUsd, 1)
    reserveMismatchRatio = reserveMismatchUsd / denom
    if (consensusMode === "require_match" && Number.isFinite(maxMismatchRatio)) {
      sourceMismatch = reserveMismatchRatio > maxMismatchRatio
    }
  }

  const coverageBps = toFiniteNumber(onchain?.receiver?.lastCoverageBps)
  const onchainMinCoverageBps = toFiniteNumber(onchain?.receiver?.minCoverageBps)
  const minCoverageBps = Number.isFinite(minCoverageBpsOverride) ? minCoverageBpsOverride : onchainMinCoverageBps

  const enforcementHookWired = Boolean(onchain?.enforcement?.hookWired)
  const forwarderSet = Boolean(onchain?.enforcement?.forwarderSet)
  const mintingPaused = onchain?.receiver?.mintingPaused
  const mintingEnabled = onchain?.token?.mintingEnabled

  const reasons = []
  if (onchain?.error) reasons.push("onchain_unavailable")
  if (reserveStale) reasons.push("reserve_data_stale")
  if (reserveSignatureInvalid) reasons.push("reserve_signature_invalid")
  if (sourceMismatch) reasons.push("reserve_source_mismatch")
  if (incident?.active) reasons.push("incident_active")
  if (!enforcementHookWired) reasons.push("enforcement_not_wired")
  if (!forwarderSet) reasons.push("forwarder_not_set")
  if (mintingPaused === true) reasons.push("minting_paused")
  if (mintingEnabled === false) reasons.push("minting_disabled")
  if (Number.isFinite(coverageBps) && Number.isFinite(minCoverageBps) && coverageBps < minCoverageBps) {
    reasons.push("coverage_below_threshold")
  }

  let previewStatus = "HEALTHY"
  if (onchain?.error || reserveStale || reserveSignatureInvalid) previewStatus = "STALE"
  else if (sourceMismatch) previewStatus = "DEGRADED"
  else if (incident?.active) previewStatus = incident?.severity === "critical" ? "UNHEALTHY" : "DEGRADED"
  else if (!enforcementHookWired) previewStatus = "DEGRADED"
  else if (!forwarderSet) previewStatus = "DEGRADED"
  else if (
    reasons.includes("coverage_below_threshold") ||
    reasons.includes("minting_paused") ||
    reasons.includes("minting_disabled")
  ) {
    previewStatus = "UNHEALTHY"
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
    reserveMismatchUsd,
    reserveMismatchRatio,
    previewStatus,
    reasons,
  }
}

const POLICY_TEMPLATES = [
  {
    id: "conservative_stablecoin",
    label: "Conservative stablecoin",
    policy: {
      consensusMode: "require_match",
      minCoverageBps: "10000",
      maxReserveAgeS: "120",
      maxMismatchRatio: "0.005",
    },
  },
  {
    id: "yield_bearing_rwa",
    label: "Yield-bearing RWA",
    policy: {
      consensusMode: "primary_only",
      minCoverageBps: "10000",
      maxReserveAgeS: "300",
      maxMismatchRatio: "0.02",
    },
  },
  {
    id: "multi_custodian",
    label: "Multi-custodian",
    policy: {
      consensusMode: "conservative_min",
      minCoverageBps: "10000",
      maxReserveAgeS: "180",
      maxMismatchRatio: "0.01",
    },
  },
]

export default function SettingsTab({
  projectId,
  isLiveProject,
  derived,
  interfaces,
  operator,
  status,
  draftProject,
  draftPolicies,
  onSaveDraftPolicies,
  mode: demoMode,
  onSetMode,
  busy,
}) {
  const policyItems = [
    { label: "Max reserve age (s)", value: derived?.maxReserveAgeS },
    { label: "Max mismatch ratio", value: derived?.maxMismatchRatio },
    { label: "Min coverage bps", value: derived?.minCoverageBps },
  ]

  const interfaceItems = [
    {
      label: "Policy setter",
      value: `${formatMaybe(interfaces?.policy?.contract)}.${formatMaybe(interfaces?.policy?.function)}`,
    },
    {
      label: "Report receiver",
      value: `${formatMaybe(interfaces?.reportReceiver?.contract)}.${formatMaybe(interfaces?.reportReceiver?.function)}`,
    },
    {
      label: "Enforcement hook",
      value: `${formatMaybe(interfaces?.enforcementHook?.contract)}.${formatMaybe(interfaces?.enforcementHook?.function)}`,
    },
  ]

  const recommendations =
    Array.isArray(operator?.recommendedActions) && operator.recommendedActions.length
      ? operator.recommendedActions
      : []

  const existingDraftPolicy = useMemo(() => {
    if (!projectId) return null
    return (draftPolicies || []).find((p) => p && p.projectId === projectId) || null
  }, [draftPolicies, projectId])

  const [draftForm, setDraftForm] = useState({
    consensusMode: "require_match",
    minCoverageBps: "",
    maxReserveAgeS: "",
    maxMismatchRatio: "",
  })

  const [draftError, setDraftError] = useState("")
  const [draftSavedAt, setDraftSavedAt] = useState(null)

  const [runBroadcast, setRunBroadcast] = useState(false)
  const [runState, setRunState] = useState(null)
  const [runError, setRunError] = useState("")
  const [runId, setRunId] = useState(null)
  const [runOutput, setRunOutput] = useState("")

  const startRun = useCallback(async () => {
    if (!isLiveProject) return

    setRunError("")
    setRunOutput("")
    setRunState("starting")
    setRunId(null)

    try {
      const res = await fetchJson("/admin/run", {
        method: "POST",
        body: {
          broadcast: Boolean(runBroadcast),
        },
        timeoutMs: 12000,
      })

      const nextRunId = res?.runId || null
      const nextRun = res?.run || null

      setRunId(nextRunId)
      setRunState(nextRun?.state || "running")
      setRunOutput(String(nextRun?.output || ""))
      setRunError(nextRun?.error ? String(nextRun.error) : "")
    } catch (err) {
      setRunState("error")
      setRunError(String(err?.message || err))
    }
  }, [isLiveProject, runBroadcast])

  useEffect(() => {
    if (!isLiveProject) return
    if (!runId) return
    if (runState !== "running" && runState !== "starting") return

    let alive = true
    const tick = async () => {
      try {
        const res = await fetchJson(`/admin/run/${encodeURIComponent(runId)}`, { timeoutMs: 12000 })
        if (!alive) return
        const r = res?.run || null
        if (r) {
          setRunState(r.state || null)
          setRunOutput(String(r.output || ""))
          setRunError(r.error ? String(r.error) : "")
        }
      } catch (err) {
        if (!alive) return
        setRunError(String(err?.message || err))
      }
    }

    void tick()
    const t = setInterval(() => {
      void tick()
    }, 1500)

    return () => {
      alive = false
      clearInterval(t)
    }
  }, [isLiveProject, runId, runState])

  useEffect(() => {
    setDraftError("")
    setDraftSavedAt(null)
    if (!projectId) {
      setDraftForm({
        consensusMode: "require_match",
        minCoverageBps: "",
        maxReserveAgeS: "",
        maxMismatchRatio: "",
      })
      return
    }

    if (existingDraftPolicy) {
      setDraftForm({
        consensusMode: existingDraftPolicy.consensusMode || "require_match",
        minCoverageBps: asText(existingDraftPolicy.minCoverageBps),
        maxReserveAgeS: asText(existingDraftPolicy.maxReserveAgeS),
        maxMismatchRatio: asText(existingDraftPolicy.maxMismatchRatio),
      })
      return
    }

    setDraftForm({
      consensusMode: "require_match",
      minCoverageBps: "",
      maxReserveAgeS: "",
      maxMismatchRatio: "",
    })
  }, [existingDraftPolicy, projectId])

  const resolvedPolicy = useMemo(() => {
    const maxReserveAgeS =
      asText(draftForm.maxReserveAgeS).trim() ||
      asText(derived?.maxReserveAgeS).trim() ||
      asText(draftProject?.maxReserveAgeS).trim()

    const maxMismatchRatio =
      asText(draftForm.maxMismatchRatio).trim() ||
      asText(derived?.maxMismatchRatio).trim() ||
      asText(draftProject?.maxReserveMismatchRatio).trim()

    const minCoverageBps = asText(draftForm.minCoverageBps).trim() || asText(derived?.minCoverageBps).trim() || "10000"

    return {
      consensusMode: draftForm.consensusMode || "require_match",
      maxReserveAgeS,
      maxMismatchRatio,
      minCoverageBps,
    }
  }, [derived, draftForm, draftProject])

  const preview = useMemo(() => {
    if (!status) return null
    return computePreview({ status, policy: resolvedPolicy })
  }, [resolvedPolicy, status])

  const studio = useMemo(() => {
    if (!status || !preview) return null

    const currentDerived = status?.derived || {}
    const currentStatus = typeof currentDerived?.status === "string" ? currentDerived.status : "STALE"
    const currentReasons = Array.isArray(currentDerived?.reasons) ? currentDerived.reasons : []

    const maxReserveAgeS = toFiniteNumber(preview?.maxReserveAgeS)
    const maxMismatchRatio = toFiniteNumber(preview?.maxMismatchRatio)
    const minCoverageBps = toFiniteNumber(preview?.minCoverageBps)

    const primaryAgeS = toFiniteNumber(preview?.reserveAgesS?.primary)
    const secondaryAgeS = toFiniteNumber(preview?.reserveAgesS?.secondary)
    const maxObservedAgeS =
      typeof primaryAgeS === "number" && typeof secondaryAgeS === "number"
        ? Math.max(primaryAgeS, secondaryAgeS)
        : typeof primaryAgeS === "number"
          ? primaryAgeS
          : typeof secondaryAgeS === "number"
            ? secondaryAgeS
            : null

    const stalenessSlackS =
      Number.isFinite(maxReserveAgeS) && typeof maxObservedAgeS === "number" ? Math.floor(maxReserveAgeS - maxObservedAgeS) : null

    const mismatchRatio = toFiniteNumber(preview?.reserveMismatchRatio)
    const mismatchSlack =
      Number.isFinite(maxMismatchRatio) && typeof mismatchRatio === "number" ? maxMismatchRatio - mismatchRatio : null

    const coverageBps = toFiniteNumber(status?.onchain?.receiver?.lastCoverageBps)
    const coverageSlackBps =
      Number.isFinite(minCoverageBps) && typeof coverageBps === "number" ? Math.floor(coverageBps - minCoverageBps) : null

    const willChange = currentStatus !== preview.previewStatus

    const policyLevers = {
      canAffect: new Set([
        "reserve_data_stale",
        "reserve_source_mismatch",
        "coverage_below_threshold",
      ]),
      cannotAffect: new Set([
        "onchain_unavailable",
        "reserve_signature_invalid",
        "incident_active",
        "enforcement_not_wired",
        "forwarder_not_set",
        "minting_paused",
        "minting_disabled",
      ]),
    }

    const nonPolicyReasons = preview.reasons.filter((r) => policyLevers.cannotAffect.has(r))

    return {
      currentStatus,
      currentReasons,
      previewStatus: preview.previewStatus,
      previewReasons: preview.reasons,
      willChange,
      stalenessSlackS,
      mismatchSlack,
      coverageSlackBps,
      nonPolicyReasons,
    }
  }, [preview, status])

  const enforcementReadiness = useMemo(() => {
    if (!isLiveProject || !status) return null

    const onchain = status?.onchain || {}
    const enforcement = onchain?.enforcement || {}
    const permissions = onchain?.permissions || {}
    const token = onchain?.token || {}
    const receiver = onchain?.receiver || {}

    const rpcOk = !onchain?.error
    const rpcDetail = rpcOk
      ? onchain?.blockNumber
        ? `ok @ ${onchain.blockNumber}`
        : "ok"
      : String(onchain?.error || "error")

    const hookWiredOk = Boolean(enforcement?.hookWired)
    const forwarderSetOk = Boolean(enforcement?.forwarderSet)

    const expectedForwarder = enforcement?.expectedForwarder
    const expectedForwarderConfiguredOk = Boolean(expectedForwarder)

    const forwarderMatchesExpected = enforcement?.forwarderMatchesExpected
    const forwarderMatchesExpectedState =
      forwarderMatchesExpected === null || forwarderMatchesExpected === undefined
        ? "unknown"
        : forwarderMatchesExpected
          ? "pass"
          : "fail"

    const receiverOwnerOk = isNonZeroAddress(permissions?.receiverOwner || receiver?.owner)
    const tokenOwnerOk = isNonZeroAddress(permissions?.tokenOwner || token?.owner)
    const guardianOk = isNonZeroAddress(permissions?.guardian || token?.guardian)

    const items = [
      { label: "RPC health", state: rpcOk ? "pass" : "fail", detail: rpcDetail },
      { label: "Enforcement hook wired", state: hookWiredOk ? "pass" : "fail", detail: hookWiredOk ? "wired" : "not wired" },
      { label: "Forwarder set", state: forwarderSetOk ? "pass" : "fail", detail: forwarderSetOk ? "set" : "not set" },
      {
        label: "Expected forwarder configured",
        state: expectedForwarderConfiguredOk ? "pass" : "fail",
        detail: expectedForwarderConfiguredOk ? "configured" : "missing",
      },
      {
        label: "Forwarder matches expected",
        state: forwarderMatchesExpectedState,
        detail:
          forwarderMatchesExpectedState === "unknown"
            ? "no expected forwarder"
            : forwarderMatchesExpected
              ? "match"
              : "mismatch",
      },
      { label: "Receiver owner set", state: receiverOwnerOk ? "pass" : "warn", detail: receiverOwnerOk ? "set" : "missing" },
      { label: "Token owner set", state: tokenOwnerOk ? "pass" : "warn", detail: tokenOwnerOk ? "set" : "missing" },
      { label: "Guardian set", state: guardianOk ? "pass" : "warn", detail: guardianOk ? "set" : "missing" },
      { label: "Gas limit", state: "info", detail: "export default: 900000" },
    ]

    const links = status?.links || {}
    const linkEntries = [
      ["Receiver", links?.receiver],
      ["Token", links?.token],
      ["Guardian", links?.guardian],
      ["Forwarder", links?.forwarder],
      ["Latest Tx", links?.lastTx],
    ].filter(([, url]) => typeof url === "string" && url.length)

    const addresses = [
      { label: "Receiver owner", value: permissions?.receiverOwner || receiver?.owner || "--", url: links?.receiverOwner },
      { label: "Token owner", value: permissions?.tokenOwner || token?.owner || "--", url: links?.tokenOwner },
      { label: "Guardian", value: permissions?.guardian || token?.guardian || "--", url: links?.guardian },
      { label: "Forwarder", value: permissions?.forwarderAddress || receiver?.forwarderAddress || "--", url: links?.forwarder },
      {
        label: "Expected forwarder",
        value: enforcement?.expectedForwarder || "--",
        url: enforcement?.expectedForwarder ? `${links?.explorerBase || "https://sepolia.etherscan.io"}/address/${enforcement.expectedForwarder}` : null,
      },
    ]

    return {
      items,
      linkEntries,
      addresses,
    }
  }, [isLiveProject, status])

  const saveDraftPolicy = () => {
    if (!projectId) return
    if (typeof onSaveDraftPolicies !== "function") return

    if (
      draftForm.consensusMode !== "primary_only" &&
      draftForm.consensusMode !== "require_match" &&
      draftForm.consensusMode !== "conservative_min"
    ) {
      setDraftError("Consensus mode is invalid")
      return
    }

    const clean = {
      projectId,
      consensusMode: draftForm.consensusMode || "require_match",
      minCoverageBps: asText(draftForm.minCoverageBps).trim(),
      maxReserveAgeS: asText(draftForm.maxReserveAgeS).trim(),
      maxMismatchRatio: asText(draftForm.maxMismatchRatio).trim(),
      updatedAt: Date.now(),
    }

    const minCoverageBps = clean.minCoverageBps ? Number(clean.minCoverageBps) : null
    if (clean.minCoverageBps && !Number.isFinite(minCoverageBps)) {
      setDraftError("Min coverage bps must be a number")
      return
    }

    const maxReserveAgeS = clean.maxReserveAgeS ? Number(clean.maxReserveAgeS) : null
    if (clean.maxReserveAgeS && (!Number.isFinite(maxReserveAgeS) || maxReserveAgeS < 0)) {
      setDraftError("Max reserve age must be a non-negative number")
      return
    }

    const maxMismatchRatio = clean.maxMismatchRatio ? Number(clean.maxMismatchRatio) : null
    if (clean.maxMismatchRatio && (!Number.isFinite(maxMismatchRatio) || maxMismatchRatio < 0)) {
      setDraftError("Max mismatch ratio must be a non-negative number")
      return
    }

    const prev = Array.isArray(draftPolicies) ? draftPolicies : []
    const rest = prev.filter((p) => !(p && p.projectId === projectId))
    onSaveDraftPolicies([...rest, clean])
    setDraftError("")
    setDraftSavedAt(Date.now())
  }

  const clearDraftPolicy = () => {
    if (!projectId) return
    if (typeof onSaveDraftPolicies !== "function") return
    const prev = Array.isArray(draftPolicies) ? draftPolicies : []
    const next = prev.filter((p) => !(p && p.projectId === projectId))
    onSaveDraftPolicies(next)
    setDraftSavedAt(Date.now())
    setDraftError("")
  }

  return (
    <div className="tab-content">
      <h2 className="tab-title">Policy</h2>
      <p className="tab-subtitle">Policy parameters and operational controls</p>

      {!projectId ? (
        <div className="card">
          <div className="empty-row">Select a project to configure policy.</div>
        </div>
      ) : (
        <>
          <div className="detail-section">
            <h3 className="section-title">Draft Policy</h3>
            <p className="tab-subtitle">Saved as draft configuration. Used for export + preview.</p>

            <div className="form">
              <div className="form-actions" style={{ justifyContent: "flex-start" }}>
                {POLICY_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => {
                      setDraftForm({
                        consensusMode: tpl.policy.consensusMode,
                        minCoverageBps: tpl.policy.minCoverageBps,
                        maxReserveAgeS: tpl.policy.maxReserveAgeS,
                        maxMismatchRatio: tpl.policy.maxMismatchRatio,
                      })
                      setDraftSavedAt(null)
                      setDraftError("")
                    }}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>

              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Consensus mode</span>
                  <select
                    className="text-input"
                    value={draftForm.consensusMode}
                    onChange={(e) => setDraftForm((s) => ({ ...s, consensusMode: e.target.value }))}
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
                    value={draftForm.minCoverageBps}
                    onChange={(e) => setDraftForm((s) => ({ ...s, minCoverageBps: e.target.value }))}
                    placeholder={asText(derived?.minCoverageBps) || "10000"}
                  />
                </label>

                <label className="field">
                  <span className="field-label">Max reserve age (s)</span>
                  <input
                    className="text-input"
                    value={draftForm.maxReserveAgeS}
                    onChange={(e) => setDraftForm((s) => ({ ...s, maxReserveAgeS: e.target.value }))}
                    placeholder={asText(derived?.maxReserveAgeS) || asText(draftProject?.maxReserveAgeS) || "120"}
                  />
                </label>

                <label className="field">
                  <span className="field-label">Max mismatch ratio</span>
                  <input
                    className="text-input"
                    value={draftForm.maxMismatchRatio}
                    onChange={(e) => setDraftForm((s) => ({ ...s, maxMismatchRatio: e.target.value }))}
                    placeholder={asText(derived?.maxMismatchRatio) || asText(draftProject?.maxReserveMismatchRatio) || "0.01"}
                  />
                </label>
              </div>

              {draftError && <div className="form-error">{draftError}</div>}

              <div className="form-actions">
                <button className="btn btn-ghost" disabled={busy} onClick={clearDraftPolicy}>
                  Clear
                </button>
                <button className="btn btn-primary" disabled={busy} onClick={saveDraftPolicy}>
                  Save policy
                </button>
              </div>

              {draftSavedAt && (
                <div className="empty-row">Saved.</div>
              )}
            </div>
          </div>

          <div className="detail-section">
            <h3 className="section-title">Policy Studio</h3>
            <p className="tab-subtitle">Simulate changes against the latest data and see what will flip status.</p>

            {!studio ? (
              <div className="card">
                <div className="empty-row">Policy studio becomes available once status data is loaded.</div>
              </div>
            ) : (
              <div className="detail-grid">
                <div className="detail-card">
                  <span className="detail-label">Current status</span>
                  <span className="detail-value">
                    <StatusPill status={studio.currentStatus} />
                  </span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Preview status</span>
                  <span className="detail-value">
                    <StatusPill status={studio.previewStatus} />
                  </span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Change</span>
                  <span className="detail-value">{studio.willChange ? `${studio.currentStatus} → ${studio.previewStatus}` : "No change"}</span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Non-policy reasons</span>
                  <span className="detail-value">
                    {studio.nonPolicyReasons.length ? studio.nonPolicyReasons.join(", ") : "--"}
                  </span>
                </div>

                <div className="detail-card">
                  <span className="detail-label">Staleness slack (s)</span>
                  <span className="detail-value">{formatMaybe(studio.stalenessSlackS)}</span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Mismatch slack</span>
                  <span className="detail-value">{formatMaybe(studio.mismatchSlack)}</span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Coverage slack (bps)</span>
                  <span className="detail-value">{formatMaybe(studio.coverageSlackBps)}</span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Preview reasons</span>
                  <span className="detail-value">{studio.previewReasons?.length ? studio.previewReasons.join(", ") : "--"}</span>
                </div>
              </div>
            )}
          </div>

          <div className="detail-section">
            <h3 className="section-title">Preview</h3>
            {!preview ? (
              <div className="card">
                <div className="empty-row">Preview is available when status data is loaded.</div>
              </div>
            ) : (
              <div className="detail-grid">
                <div className="detail-card">
                  <span className="detail-label">Preview status</span>
                  <span className="detail-value">
                    <StatusPill status={preview.previewStatus} />
                  </span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Consensus</span>
                  <span className="detail-value">{formatMaybe(preview.consensusMode)}</span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Primary age (s)</span>
                  <span className="detail-value">{formatMaybe(preview.reserveAgesS?.primary)}</span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Secondary age (s)</span>
                  <span className="detail-value">{formatMaybe(preview.reserveAgesS?.secondary)}</span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Mismatch ratio</span>
                  <span className="detail-value">{formatMaybe(preview.reserveMismatchRatio)}</span>
                </div>
                <div className="detail-card">
                  <span className="detail-label">Reasons</span>
                  <span className="detail-value">{preview.reasons?.length ? preview.reasons.join(", ") : "--"}</span>
                </div>
              </div>
            )}
          </div>

          <div className="detail-section">
            <h3 className="section-title">Enforcement Readiness</h3>
            <p className="tab-subtitle">Verify roles, wiring, and RPC before deploying enforcement.</p>

            {!enforcementReadiness ? (
              <div className="card">
                <div className="empty-row">Checklist is available when a live project is selected.</div>
              </div>
            ) : (
              <>
                <div className="detail-grid">
                  {enforcementReadiness.items.map((item) => {
                    const pillClass =
                      item.state === "pass"
                        ? "env-ok"
                        : item.state === "fail"
                          ? "env-bad"
                          : item.state === "warn"
                            ? "env-warn"
                            : "env-mode"

                    const label = item.state === "pass" ? "PASS" : item.state === "fail" ? "FAIL" : item.state === "warn" ? "WARN" : "INFO"

                    return (
                      <div key={item.label} className="detail-card">
                        <span className="detail-label">{item.label}</span>
                        <span className="detail-value">
                          <span className={`env-pill ${pillClass}`}>{label}</span>
                        </span>
                        <span className="detail-label">Detail</span>
                        <span className="detail-value">{formatMaybe(item.detail)}</span>
                      </div>
                    )
                  })}
                </div>

                <div className="detail-section">
                  <h3 className="section-title">Roles & Addresses</h3>
                  <div className="detail-grid">
                    {enforcementReadiness.addresses.map((item) => (
                      <div key={item.label} className="detail-card">
                        <span className="detail-label">{item.label}</span>
                        <span className="detail-value mono">{formatMaybe(item.value)}</span>
                        <span className="detail-label">Explorer</span>
                        <span className="detail-value">
                          {item.url ? (
                            <a href={item.url} target="_blank" rel="noreferrer" className="explorer-link">
                              Open ↗
                            </a>
                          ) : (
                            "--"
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {enforcementReadiness.linkEntries.length > 0 && (
                  <div className="detail-section">
                    <h3 className="section-title">Explorer Links</h3>
                    <div className="links-row">
                      {enforcementReadiness.linkEntries.map(([label, url]) => (
                        <a key={label} href={url} target="_blank" rel="noreferrer" className="explorer-link">
                          {label} ↗
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="detail-section">
            <h3 className="section-title">On-demand Run</h3>
            <p className="tab-subtitle">Trigger a single CRE workflow run from the console.</p>

            <div className="card">
              <div className="form">
                <div className="form-grid">
                  <label className="field span-2">
                    <span className="field-label">Broadcast onchain</span>
                    <select
                      className="text-input"
                      value={runBroadcast ? "yes" : "no"}
                      onChange={(e) => setRunBroadcast(e.target.value === "yes")}
                      disabled={busy || runState === "running" || runState === "starting"}
                    >
                      <option value="no">No (simulate only)</option>
                      <option value="yes">Yes (requires funded key in server .env)</option>
                    </select>
                  </label>
                </div>

                <div className="form-actions">
                  <button
                    className="btn btn-primary"
                    disabled={busy || runState === "running" || runState === "starting"}
                    onClick={() => void startRun()}
                  >
                    {runState === "running" || runState === "starting" ? "Running..." : "Run now"}
                  </button>
                </div>

                <div className="detail-grid">
                  <div className="detail-card">
                    <span className="detail-label">State</span>
                    <span className="detail-value">{formatMaybe(runState)}</span>
                  </div>
                  <div className="detail-card">
                    <span className="detail-label">Run ID</span>
                    <span className="detail-value mono">{formatMaybe(runId)}</span>
                  </div>
                </div>

                {runError && <div className="form-error">{runError}</div>}

                {runOutput && (
                  <div className="export-section">
                    <div className="export-title">Output</div>
                    <pre className="code-block">{runOutput}</pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="detail-section">
        <h3 className="section-title">Policy Parameters</h3>
        <div className="detail-grid">
          {policyItems.map((item) => (
            <div key={item.label} className="detail-card">
              <span className="detail-label">{item.label}</span>
              <span className="detail-value">{formatMaybe(item.value)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h3 className="section-title">Contract Interfaces</h3>
        <div className="detail-grid">
          {interfaceItems.map((item) => (
            <div key={item.label} className="detail-card">
              <span className="detail-label">{item.label}</span>
              <span className="detail-value mono">{item.value}</span>
            </div>
          ))}
        </div>
      </div>

      {recommendations.length > 0 && (
        <div className="detail-section">
          <h3 className="section-title">Operator Recommendations</h3>
          <ul className="recommendations-list">
            {recommendations.map((rec) => (
              <li key={rec}>{rec}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="section-divider" />

      {isLiveProject && (
        <div className="detail-section">
          <h3 className="section-title">Demo Controls</h3>
          <p className="tab-subtitle">Hackathon-only. Remove for production.</p>

          <div className="demo-controls">
            <span className="demo-mode">Current mode: <strong>{demoMode || "--"}</strong></span>
            <div className="demo-buttons">
              <button className="btn btn-ok" disabled={busy} onClick={() => onSetMode("healthy")}>
                Set Healthy
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => onSetMode("unhealthy")}>
                Set Unhealthy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
