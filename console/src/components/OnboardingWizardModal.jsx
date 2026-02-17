import { useEffect, useMemo, useState } from "react"

const emptyProject = {
  id: "",
  name: "",
  symbol: "",
  chainSelectorName: "ethereum-testnet-sepolia",
  rpcUrl: "",
  explorerBaseUrl: "https://sepolia.etherscan.io",
  receiverAddress: "",
  liabilityTokenAddress: "",
  expectedForwarderAddress: "",
  maxReserveAgeS: "",
  maxReserveMismatchRatio: "",
}

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

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const buildActiveExport = ({ project, connectors, policy }) => {
  if (!project?.id) return null

  const primary = connectors.find((c) => String(c.role || "") === "primary") || null
  const secondary = connectors.find((c) => String(c.role || "") === "secondary") || null

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

  const workflowConfig = {
    schedule: "*/300 * * * * *",
    chainSelectorName: project.chainSelectorName,
    receiverAddress: project.receiverAddress,
    liabilityTokenAddress: project.liabilityTokenAddress,
    reserveUrlPrimary: primary?.url ? String(primary.url) : "<set-me>",
    reserveUrlSecondary: secondary?.url ? String(secondary.url) : "<set-me>",
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
}) {
  const steps = [
    { id: "project", label: "Project" },
    { id: "connect", label: "Connect" },
    { id: "policy", label: "Policy" },
    { id: "export", label: "Go live" },
  ]

  const [stepIdx, setStepIdx] = useState(0)
  const step = steps[stepIdx]?.id || "project"

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

  useEffect(() => {
    if (!open) return
    setStepIdx(0)
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
  }, [open])

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

    return [primary, secondary].filter((c) => c.url)
  }, [connectForm, projectForm.id])

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
      explorerBaseUrl: String(projectForm.explorerBaseUrl || "").trim(),
      receiverAddress: String(projectForm.receiverAddress || "").trim(),
      liabilityTokenAddress: String(projectForm.liabilityTokenAddress || "").trim(),
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

    const conflictLive = (serverProjects || []).some((p) => normalizeId(p?.id) === id)
    if (conflictLive) return "That project ID already exists as a live project"

    const conflictDraft = (draftProjects || []).some((p) => normalizeId(p?.id) === id)
    if (conflictDraft) return "That project ID already exists as a draft"

    return ""
  }

  const validateConnectors = () => {
    if (!draftProjectId) return "Create the project first"

    const primaryUrl = String(connectForm.primary?.url || "").trim()
    if (!primaryUrl) return "Primary reserve feed URL is required"

    const primaryName = String(connectForm.primary?.name || "").trim()
    if (!primaryName) return "Primary reserve feed name is required"

    const secondaryUrl = String(connectForm.secondary?.url || "").trim()
    if (!secondaryUrl) return "Secondary reserve feed URL is required"

    const secondaryName = String(connectForm.secondary?.name || "").trim()
    if (!secondaryName) return "Secondary reserve feed name is required"

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
      explorerBaseUrl: String(projectForm.explorerBaseUrl || "").trim(),
      receiverAddress: String(projectForm.receiverAddress || "").trim(),
      liabilityTokenAddress: String(projectForm.liabilityTokenAddress || "").trim(),
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

  const onNext = () => {
    setError("")

    if (step === "project") {
      const msg = validateProject()
      if (msg) {
        setError(msg)
        return
      }
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
      if (typeof onClose === "function") onClose()
    }
  }

  const onBack = () => {
    setError("")
    setStepIdx((s) => Math.max(0, s - 1))
  }

  const testConnection = async (key) => {
    const cfg = key === "primary" ? connectForm.primary : connectForm.secondary
    const url = String(cfg?.url || "").trim()
    if (!url) return

    setTestBusy(key)

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
      const signer = data?.signer
      const signature = data?.signature

      if (!timestamp || !reserveUsd) {
        throw new Error("Response missing required fields (timestamp, reserveUsd)")
      }

      const expectedSigner = String(cfg?.expectedSigner || "").trim()
      if (expectedSigner) {
        const okSigner = String(signer || "").toLowerCase() === expectedSigner.toLowerCase()
        if (!okSigner) {
          throw new Error("Signer does not match expected signer")
        }
        if (!signature) {
          throw new Error("Response missing signature")
        }
      }

      setTestResult((s) => ({
        ...s,
        [key]: {
          at: Date.now(),
          ok: true,
          message: `ok reserveUsd=${reserveUsd}${navUsd ? ` navUsd=${navUsd}` : ""} ts=${timestamp}${signer ? ` signer=${signer}` : ""}`,
        },
      }))
    } catch (err) {
      setTestResult((s) => ({
        ...s,
        [key]: {
          at: Date.now(),
          ok: false,
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
                <label className="field">
                  <span className="field-label">Project ID</span>
                  <input
                    className="text-input"
                    value={projectForm.id}
                    onChange={(e) => setProjectForm((s) => ({ ...s, id: e.target.value }))}
                    placeholder="reservewatch-sepolia"
                  />
                </label>

                <label className="field">
                  <span className="field-label">Name</span>
                  <input
                    className="text-input"
                    value={projectForm.name}
                    onChange={(e) => setProjectForm((s) => ({ ...s, name: e.target.value }))}
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
                  <span className="field-label">Chain selector</span>
                  <input
                    className="text-input"
                    value={projectForm.chainSelectorName}
                    onChange={(e) => setProjectForm((s) => ({ ...s, chainSelectorName: e.target.value }))}
                    placeholder="ethereum-testnet-sepolia"
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">RPC URL</span>
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
              </div>
            </div>
          )}

          {step === "connect" && (
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
                        onChange={(e) => setConnectForm((s) => ({ ...s, primary: { ...s.primary, name: e.target.value } }))}
                        placeholder="Primary reserve feed"
                      />
                    </label>

                    <label className="field span-2">
                      <span className="field-label">URL</span>
                      <input
                        className="text-input"
                        value={connectForm.primary.url}
                        onChange={(e) => setConnectForm((s) => ({ ...s, primary: { ...s.primary, url: e.target.value } }))}
                        placeholder="https://..."
                      />
                    </label>

                    <label className="field span-2">
                      <span className="field-label">Expected signer (optional)</span>
                      <input
                        className="text-input"
                        value={connectForm.primary.expectedSigner}
                        onChange={(e) =>
                          setConnectForm((s) => ({ ...s, primary: { ...s.primary, expectedSigner: e.target.value } }))
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
                          setConnectForm((s) => ({ ...s, secondary: { ...s.secondary, expectedSigner: e.target.value } }))
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
            </div>
          )}

          {step === "policy" && (
            <div className="form">
              <div className="form-grid">
                <label className="field span-2">
                  <span className="field-label">Consensus mode</span>
                  <select
                    className="text-input"
                    value={policyForm.consensusMode}
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
              </div>
            </div>
          )}

          {step === "export" && (
            <div className="export">
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
