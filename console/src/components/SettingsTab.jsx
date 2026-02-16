import { useEffect, useMemo, useState } from "react"

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

const computePreview = ({ status, policy }) => {
  const now = Math.floor(Date.now() / 1000)

  const reserves = status?.reserves || {}
  const onchain = status?.onchain || {}
  const incident = status?.incident || null

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
  if (onchain?.error || reserveStale) previewStatus = "STALE"
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
    if (!isLiveProject || !status) return null
    return computePreview({ status, policy: resolvedPolicy })
  }, [isLiveProject, resolvedPolicy, status])

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
            <h3 className="section-title">Draft Policy (Local)</h3>
            <p className="tab-subtitle">Saved in this browser. Used for export + preview.</p>

            <div className="form">
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
            <h3 className="section-title">Preview</h3>
            {!preview ? (
              <div className="card">
                <div className="empty-row">Preview is available when a live project is selected.</div>
              </div>
            ) : (
              <div className="detail-grid">
                <div className="detail-card">
                  <span className="detail-label">Preview status</span>
                  <span className="detail-value">{formatMaybe(preview.previewStatus)}</span>
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
