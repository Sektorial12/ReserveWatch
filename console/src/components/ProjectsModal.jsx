import { useEffect, useMemo, useRef, useState } from "react"

import { isAddress } from "viem"

const emptyDraft = {
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

const normalizeId = (id) => String(id || "").trim()

const normalizeConnectorId = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
}

const ensureArray = (value) => (Array.isArray(value) ? value : [])

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

const normalizeDraftProject = (project) => {
  if (!project || typeof project !== "object") return null
  const id = normalizeId(project.id)
  if (!id) return null
  return { ...emptyDraft, ...project, id }
}

const normalizeDraftConnector = (connector) => {
  if (!connector || typeof connector !== "object") return null
  const id = normalizeConnectorId(connector.id)
  const projectId = normalizeId(connector.projectId)
  if (!id || !projectId) return null
  return { ...connector, id, projectId }
}

const normalizeDraftPolicy = (policy) => {
  if (!policy || typeof policy !== "object") return null
  const projectId = normalizeId(policy.projectId)
  if (!projectId) return null
  return { ...policy, projectId }
}

const mergeByKey = (existing, incoming, keyFn) => {
  const map = new Map()
  ensureArray(existing).forEach((item) => {
    if (!item) return
    const key = keyFn(item)
    if (key) map.set(key, item)
  })
  ensureArray(incoming).forEach((item) => {
    if (!item) return
    const key = keyFn(item)
    if (key) map.set(key, item)
  })
  return Array.from(map.values())
}

const resolveImportPayload = (payload) => {
  if (!payload || typeof payload !== "object") return null

  if (payload.inputs && typeof payload.inputs === "object") {
    const inputs = payload.inputs
    const project = inputs.draftProject || null
    const connectors = inputs.draftConnectors || []
    const policy = inputs.draftPolicy || null
    return {
      projects: project ? [project] : [],
      connectors,
      policies: policy ? [policy] : [],
      selectedProjectId: project?.id || payload.projectId || "",
    }
  }

  const draftsRoot = payload.drafts && typeof payload.drafts === "object" ? payload.drafts : payload
  const projects = draftsRoot.draftProjects ?? draftsRoot.projects ?? null
  const connectors = draftsRoot.draftConnectors ?? draftsRoot.connectors ?? null
  const policies = draftsRoot.draftPolicies ?? draftsRoot.policies ?? null

  if (!projects && !connectors && !policies) return null

  return {
    projects: projects || [],
    connectors: connectors || [],
    policies: policies || [],
    selectedProjectId: draftsRoot.defaultProjectId || payload.defaultProjectId || payload.projectId || "",
  }
}

export default function ProjectsModal({
  open,
  onClose,
  serverProjects,
  draftProjects,
  draftConnectors,
  draftPolicies,
  onSaveDraftConnectors,
  onSaveDraftPolicies,
  onSaveDraftProjects,
  onRenameDraftProjectId,
  activeProjectId,
  onSelectProjectId,
}) {
  const [mode, setMode] = useState("list")
  const [form, setForm] = useState(emptyDraft)
  const [editingOriginalId, setEditingOriginalId] = useState(null)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [importError, setImportError] = useState("")
  const [importNotice, setImportNotice] = useState("")
  const importInputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setMode("list")
    setForm(emptyDraft)
    setEditingOriginalId(null)
    setError("")
    setCopied(false)
    setImportError("")
    setImportNotice("")
  }, [open])

  const activeDraft = useMemo(() => {
    const id = normalizeId(activeProjectId)
    return draftProjects.find((p) => normalizeId(p.id) === id) || null
  }, [activeProjectId, draftProjects])

  const startCreate = () => {
    setMode("create")
    setForm({ ...emptyDraft })
    setEditingOriginalId(null)
    setError("")
  }

  const startEdit = (p) => {
    setMode("edit")
    setForm({ ...emptyDraft, ...p })
    setEditingOriginalId(normalizeId(p?.id))
    setError("")
  }

  const removeDraft = (id) => {
    const cleanId = normalizeId(id)
    const next = draftProjects.filter((p) => normalizeId(p.id) !== cleanId)
    onSaveDraftProjects(next)
    if (normalizeId(activeProjectId) === cleanId) {
      const fallback = serverProjects[0]?.id || next[0]?.id || null
      onSelectProjectId(fallback)
    }
  }

  const validate = () => {
    const id = normalizeId(form.id)
    if (!id) return "Project ID is required"
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
      return "Project ID must be 2-63 chars: lowercase letters, numbers, hyphens"
    }
    if (!String(form.name || "").trim()) return "Project name is required"
    if (!String(form.chainSelectorName || "").trim()) return "Chain selector is required"
    if (!String(form.receiverAddress || "").trim()) return "Receiver address is required"
    if (!String(form.liabilityTokenAddress || "").trim()) return "Liability token address is required"
    if (!String(form.rpcUrl || "").trim()) return "RPC URL is required"
    if (!String(form.explorerBaseUrl || "").trim()) return "Explorer base URL is required"

    const supplyChainSelectorName = String(form.supplyChainSelectorName || "").trim()
    const supplyRpcUrl = String(form.supplyRpcUrl || "").trim()
    const supplyLiabilityTokenAddress = String(form.supplyLiabilityTokenAddress || "").trim()

    if (supplyLiabilityTokenAddress && !isAddress(supplyLiabilityTokenAddress)) {
      return "Supply liability token address is invalid"
    }

    const attestationChainSelectorName = String(form.chainSelectorName || "").trim()
    const supplyDiffers =
      supplyChainSelectorName &&
      attestationChainSelectorName &&
      supplyChainSelectorName.toLowerCase() !== attestationChainSelectorName.toLowerCase()

    if (supplyDiffers && !supplyRpcUrl) {
      return "Supply RPC URL is required when supply chain differs"
    }

    const conflictLive = serverProjects.some((p) => normalizeId(p.id) === id)
    if (conflictLive) return "That project ID already exists as a live project"

    const conflictDraft = draftProjects.some((p) => normalizeId(p.id) === id)
    const isEditing = mode === "edit" && normalizeId(editingOriginalId) === id
    if (conflictDraft && !isEditing) return "That project ID already exists as a draft"

    return ""
  }

  const saveDraft = () => {
    const v = validate()
    if (v) {
      setError(v)
      return
    }

    const clean = {
      ...form,
      id: normalizeId(form.id),
      name: String(form.name || "").trim(),
      symbol: String(form.symbol || "").trim(),
      chainSelectorName: String(form.chainSelectorName || "").trim(),
      rpcUrl: String(form.rpcUrl || "").trim(),
      supplyChainSelectorName: String(form.supplyChainSelectorName || "").trim(),
      supplyRpcUrl: String(form.supplyRpcUrl || "").trim(),
      explorerBaseUrl: String(form.explorerBaseUrl || "").trim(),
      receiverAddress: String(form.receiverAddress || "").trim(),
      liabilityTokenAddress: String(form.liabilityTokenAddress || "").trim(),
      supplyLiabilityTokenAddress: String(form.supplyLiabilityTokenAddress || "").trim(),
      expectedForwarderAddress: String(form.expectedForwarderAddress || "").trim(),
      maxReserveAgeS: asText(form.maxReserveAgeS).trim(),
      maxReserveMismatchRatio: asText(form.maxReserveMismatchRatio).trim(),
    }

    const newId = normalizeId(clean.id)
    const oldId = mode === "edit" && editingOriginalId ? normalizeId(editingOriginalId) : null
    if (
      oldId &&
      newId &&
      oldId !== newId &&
      typeof onRenameDraftProjectId === "function"
    ) {
      onRenameDraftProjectId(oldId, newId)
    }

    const next = (() => {
      const removeId = mode === "edit" && editingOriginalId ? normalizeId(editingOriginalId) : newId
      const rest = draftProjects.filter((p) => normalizeId(p.id) !== removeId && normalizeId(p.id) !== newId)
      return [...rest, clean].sort((a, b) => a.id.localeCompare(b.id))
    })()

    onSaveDraftProjects(next)
    onSelectProjectId(clean.id)
    setMode("list")
    setForm(emptyDraft)
    setEditingOriginalId(null)
    setError("")
  }

  const activeExport = useMemo(() => {
    if (!activeDraft) return null

    const p = activeDraft

    const numberOrNull = (value) => {
      if (value === null || value === undefined || value === "") return null
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }

    const policy = (() => {
      const id = normalizeId(p?.id)
      if (!id) return null
      const arr = Array.isArray(draftPolicies) ? draftPolicies : []
      return arr.find((d) => d && normalizeId(d.projectId) === id) || null
    })()

    const connectors = (() => {
      const id = normalizeId(p?.id)
      if (!id) return []
      const arr = Array.isArray(draftConnectors) ? draftConnectors : []
      return arr.filter((c) => c && normalizeId(c.projectId) === id)
    })()

    const primary = connectors.find((c) => String(c.role || "") === "primary") || null
    const secondary = connectors.find((c) => String(c.role || "") === "secondary") || null

    const expectedSignerPrimary = String(primary?.expectedSigner || "").trim()
    const expectedSignerSecondary = String(secondary?.expectedSigner || "").trim()
    const expectedSigner = expectedSignerPrimary || expectedSignerSecondary || ""

    const maxReserveAgeS =
      policy?.maxReserveAgeS !== undefined && policy?.maxReserveAgeS !== null && String(policy.maxReserveAgeS).trim()
        ? numberOrNull(policy.maxReserveAgeS)
        : numberOrNull(p.maxReserveAgeS)

    const maxReserveMismatchRatio =
      policy?.maxMismatchRatio !== undefined && policy?.maxMismatchRatio !== null && String(policy.maxMismatchRatio).trim()
        ? numberOrNull(policy.maxMismatchRatio)
        : numberOrNull(p.maxReserveMismatchRatio)

    const serverProject = {
      id: p.id,
      name: p.name,
      receiverAddress: p.receiverAddress,
      liabilityTokenAddress: p.liabilityTokenAddress,
      rpcUrl: p.rpcUrl,
      explorerBaseUrl: p.explorerBaseUrl,
      expectedForwarderAddress: p.expectedForwarderAddress || null,
      maxReserveAgeS,
      maxReserveMismatchRatio,
    }

    const supplyChainSelectorName = String(p?.supplyChainSelectorName || "").trim()
    const supplyLiabilityTokenAddress = String(p?.supplyLiabilityTokenAddress || "").trim()
    const attestationChainSelectorName = String(p?.chainSelectorName || "").trim()

    const workflowConfig = {
      schedule: "*/300 * * * * *",
      chainSelectorName: p.chainSelectorName,
      supplyChainSelectorName: supplyChainSelectorName || undefined,
      attestationChainSelectorName: supplyChainSelectorName ? attestationChainSelectorName : undefined,
      receiverAddress: p.receiverAddress,
      liabilityTokenAddress: p.liabilityTokenAddress,
      supplyLiabilityTokenAddress: supplyLiabilityTokenAddress || undefined,
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
      projectId: p.id,
      generatedAt: new Date().toISOString(),
      server: {
        projectsJson: {
          defaultProjectId: p.id,
          projects: [serverProject],
        },
      },
      workflow: {
        configProductionJson: workflowConfig,
      },
      inputs: {
        draftProject: p,
        draftPolicy: policy,
        draftConnectors: connectors,
      },
    }

    return {
      serverProjectsJsonEntry: jsonStableStringify(serverProject),
      workflowConfigSnippet: jsonStableStringify(workflowConfig),
      workflowConfigFile: jsonStableStringify(workflowConfig),
      serverProjectsJsonFile: jsonStableStringify({ defaultProjectId: p.id, projects: [serverProject] }),
      bundleJson: jsonStableStringify(bundle),
    }
  }, [activeDraft, activeProjectId, draftConnectors, draftPolicies])

  const draftExport = useMemo(() => {
    const projects = ensureArray(draftProjects)
    const connectors = ensureArray(draftConnectors)
    const policies = ensureArray(draftPolicies)
    const activeDraftId =
      projects.find((p) => normalizeId(p?.id) === normalizeId(activeProjectId))?.id || ""
    const defaultProjectId = activeDraftId || projects[0]?.id || ""

    const bundle = {
      generatedAt: new Date().toISOString(),
      drafts: {
        defaultProjectId: defaultProjectId || null,
        draftProjects: projects,
        draftConnectors: connectors,
        draftPolicies: policies,
      },
    }

    return {
      bundleJson: jsonStableStringify(bundle),
      hasDrafts: Boolean(projects.length || connectors.length || policies.length),
    }
  }, [activeProjectId, draftProjects, draftConnectors, draftPolicies])

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

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return

    setImportError("")
    setImportNotice("")

    try {
      const raw = await file.text()
      const parsed = JSON.parse(raw)
      const resolved = resolveImportPayload(parsed)
      if (!resolved) {
        throw new Error("Unrecognized bundle format")
      }

      const normalizedProjects = ensureArray(resolved.projects)
        .map(normalizeDraftProject)
        .filter(Boolean)
      const normalizedConnectors = ensureArray(resolved.connectors)
        .map(normalizeDraftConnector)
        .filter(Boolean)
      const normalizedPolicies = ensureArray(resolved.policies)
        .map(normalizeDraftPolicy)
        .filter(Boolean)

      if (!normalizedProjects.length && !normalizedConnectors.length && !normalizedPolicies.length) {
        throw new Error("No draft records found in bundle")
      }

      const mergedProjects = mergeByKey(draftProjects, normalizedProjects, (p) => normalizeId(p.id)).sort((a, b) =>
        a.id.localeCompare(b.id)
      )
      const projectIds = new Set(mergedProjects.map((p) => normalizeId(p.id)))

      const mergedConnectors = mergeByKey(
        draftConnectors,
        normalizedConnectors,
        (c) => `${normalizeId(c.projectId)}:${normalizeConnectorId(c.id)}`
      ).filter((c) => projectIds.has(normalizeId(c.projectId)))

      const mergedPolicies = mergeByKey(draftPolicies, normalizedPolicies, (p) => normalizeId(p.projectId)).filter((p) =>
        projectIds.has(normalizeId(p.projectId))
      )

      if (typeof onSaveDraftProjects === "function") onSaveDraftProjects(mergedProjects)
      if (typeof onSaveDraftConnectors === "function") onSaveDraftConnectors(mergedConnectors)
      if (typeof onSaveDraftPolicies === "function") onSaveDraftPolicies(mergedPolicies)

      const desiredId = normalizeId(resolved.selectedProjectId)
      const currentId = normalizeId(activeProjectId)
      const fallbackId = normalizeId(normalizedProjects[0]?.id || mergedProjects[0]?.id || "")
      const nextId = projectIds.has(desiredId) ? desiredId : projectIds.has(currentId) ? currentId : fallbackId
      if (nextId && typeof onSelectProjectId === "function") onSelectProjectId(nextId)

      const parts = []
      if (normalizedProjects.length) {
        parts.push(`${normalizedProjects.length} project${normalizedProjects.length === 1 ? "" : "s"}`)
      }
      if (normalizedConnectors.length) {
        parts.push(`${normalizedConnectors.length} connector${normalizedConnectors.length === 1 ? "" : "s"}`)
      }
      if (normalizedPolicies.length) {
        parts.push(`${normalizedPolicies.length} ${normalizedPolicies.length === 1 ? "policy" : "policies"}`)
      }

      setImportNotice(parts.length ? `Imported ${parts.join(", ")}.` : "Import complete.")
    } catch (err) {
      setImportError(String(err?.message || err))
    }
  }

  if (!open) return null

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div>
            <h2 className="modal-title">Projects</h2>
            <p className="modal-subtitle">Create draft projects, import bundles, and export config for deployment</p>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {mode === "list" && (
          <div className="modal-body">
            <div className="modal-split">
              <div className="modal-pane">
                <div className="pane-header">
                  <h3 className="pane-title">Draft projects</h3>
                  <button className="btn btn-primary" onClick={startCreate}>
                    New draft
                  </button>
                </div>

                {draftProjects.length === 0 ? (
                  <div className="empty-state">No draft projects yet.</div>
                ) : (
                  <div className="list">
                    {draftProjects.map((p) => (
                      <div key={p.id} className={`list-row ${normalizeId(activeProjectId) === normalizeId(p.id) ? "active" : ""}`}>
                        <button className="list-main" onClick={() => onSelectProjectId(p.id)}>
                          <div className="list-title">{p.name || p.id}</div>
                          <div className="list-sub">{p.id}</div>
                        </button>
                        <div className="list-actions">
                          <button className="btn btn-ghost" onClick={() => startEdit(p)}>
                            Edit
                          </button>
                          <button className="btn btn-danger" onClick={() => removeDraft(p.id)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="pane-footer">
                  <h3 className="pane-title">Live projects</h3>
                  <div className="list compact">
                    {serverProjects.map((p) => (
                      <div key={p.id} className={`list-row ${normalizeId(activeProjectId) === normalizeId(p.id) ? "active" : ""}`}>
                        <button className="list-main" onClick={() => onSelectProjectId(p.id)}>
                          <div className="list-title">{p.name || p.id}</div>
                          <div className="list-sub">{p.id}</div>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="modal-pane">
                <h3 className="pane-title">Export & Import</h3>

                <div className="export">
                  <div className="export-section">
                    <div className="export-header">
                      <div className="export-title">Draft bundle (projects + connectors + policy)</div>
                      <div className="export-actions">
                        <button
                          className="btn btn-ghost"
                          disabled={!draftExport.hasDrafts}
                          onClick={() => void copy(draftExport.bundleJson)}
                        >
                          {copied ? "Copied" : "Copy"}
                        </button>
                        <button
                          className="btn btn-primary"
                          disabled={!draftExport.hasDrafts}
                          onClick={() => downloadText("reservewatch-drafts.json", draftExport.bundleJson)}
                        >
                          Download
                        </button>
                      </div>
                    </div>
                    {draftExport.hasDrafts ? (
                      <pre className="code-block">{draftExport.bundleJson}</pre>
                    ) : (
                      <div className="empty-state">No draft data to export yet.</div>
                    )}
                  </div>

                  <div className="export-section">
                    <div className="export-header">
                      <div className="export-title">Import draft bundle</div>
                      <div className="export-actions">
                        <input
                          ref={importInputRef}
                          className="file-input"
                          type="file"
                          accept="application/json,.json"
                          onChange={handleImportFile}
                        />
                        <button className="btn btn-ghost" onClick={() => importInputRef.current?.click()}>
                          Select JSON
                        </button>
                      </div>
                    </div>
                    {importError ? (
                      <div className="form-error">{importError}</div>
                    ) : importNotice ? (
                      <div className="form-note">{importNotice}</div>
                    ) : (
                      <div className="empty-state">Imports merge by ID and keep existing drafts unless IDs match.</div>
                    )}
                  </div>

                  {!activeExport ? (
                    <div className="empty-state">Select a draft project to export its config.</div>
                  ) : (
                    <>
                      <div className="export-section">
                        <div className="export-header">
                          <div className="export-title">Server project entry</div>
                          <button className="btn btn-ghost" onClick={() => void copy(activeExport.serverProjectsJsonEntry)}>
                            {copied ? "Copied" : "Copy"}
                          </button>
                        </div>
                        <pre className="code-block">{activeExport.serverProjectsJsonEntry}</pre>
                      </div>

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
                          <div className="export-title">Workflow config snippet</div>
                          <button className="btn btn-ghost" onClick={() => void copy(activeExport.workflowConfigSnippet)}>
                            {copied ? "Copied" : "Copy"}
                          </button>
                        </div>
                        <pre className="code-block">{activeExport.workflowConfigSnippet}</pre>
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
                              onClick={() =>
                                downloadText(
                                  `reservewatch-bundle-${normalizeId(activeProjectId) || "draft"}.json`,
                                  activeExport.bundleJson
                                )
                              }
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
              </div>
            </div>
          </div>
        )}

        {(mode === "create" || mode === "edit") && (
          <div className="modal-body">
            <div className="form">
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Project ID</span>
                  <input
                    className="text-input"
                    value={form.id}
                    onChange={(e) => setForm((s) => ({ ...s, id: e.target.value }))}
                    placeholder="reservewatch-sepolia"
                  />
                </label>

                <label className="field">
                  <span className="field-label">Name</span>
                  <input
                    className="text-input"
                    value={form.name}
                    onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
                    placeholder="My Asset"
                  />
                </label>

                <label className="field">
                  <span className="field-label">Symbol</span>
                  <input
                    className="text-input"
                    value={form.symbol}
                    onChange={(e) => setForm((s) => ({ ...s, symbol: e.target.value }))}
                    placeholder="RWA"
                  />
                </label>

                <label className="field">
                  <span className="field-label">Attestation chain selector</span>
                  <input
                    className="text-input"
                    value={form.chainSelectorName}
                    onChange={(e) => setForm((s) => ({ ...s, chainSelectorName: e.target.value }))}
                    placeholder="ethereum-testnet-sepolia"
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Attestation RPC URL</span>
                  <input
                    className="text-input"
                    value={form.rpcUrl}
                    onChange={(e) => setForm((s) => ({ ...s, rpcUrl: e.target.value }))}
                    placeholder="https://..."
                  />
                </label>

                <label className="field">
                  <span className="field-label">Supply chain selector (optional)</span>
                  <input
                    className="text-input"
                    value={form.supplyChainSelectorName}
                    onChange={(e) => setForm((s) => ({ ...s, supplyChainSelectorName: e.target.value }))}
                    placeholder="leave blank to use attestation chain"
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Supply RPC URL (optional)</span>
                  <input
                    className="text-input"
                    value={form.supplyRpcUrl}
                    onChange={(e) => setForm((s) => ({ ...s, supplyRpcUrl: e.target.value }))}
                    placeholder="leave blank to use attestation RPC"
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Explorer base URL</span>
                  <input
                    className="text-input"
                    value={form.explorerBaseUrl}
                    onChange={(e) => setForm((s) => ({ ...s, explorerBaseUrl: e.target.value }))}
                    placeholder="https://sepolia.etherscan.io"
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Receiver address</span>
                  <input
                    className="text-input"
                    value={form.receiverAddress}
                    onChange={(e) => setForm((s) => ({ ...s, receiverAddress: e.target.value }))}
                    placeholder="0x..."
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Liability token address</span>
                  <input
                    className="text-input"
                    value={form.liabilityTokenAddress}
                    onChange={(e) => setForm((s) => ({ ...s, liabilityTokenAddress: e.target.value }))}
                    placeholder="0x..."
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Supply token address (optional)</span>
                  <input
                    className="text-input"
                    value={form.supplyLiabilityTokenAddress}
                    onChange={(e) => setForm((s) => ({ ...s, supplyLiabilityTokenAddress: e.target.value }))}
                    placeholder="leave blank to use liability token"
                  />
                </label>

                <label className="field span-2">
                  <span className="field-label">Expected forwarder (optional)</span>
                  <input
                    className="text-input"
                    value={form.expectedForwarderAddress}
                    onChange={(e) => setForm((s) => ({ ...s, expectedForwarderAddress: e.target.value }))}
                    placeholder="0x..."
                  />
                </label>

                <label className="field">
                  <span className="field-label">Max reserve age (s)</span>
                  <input
                    className="text-input"
                    value={form.maxReserveAgeS}
                    onChange={(e) => setForm((s) => ({ ...s, maxReserveAgeS: e.target.value }))}
                    placeholder="3600"
                  />
                </label>

                <label className="field">
                  <span className="field-label">Max mismatch ratio</span>
                  <input
                    className="text-input"
                    value={form.maxReserveMismatchRatio}
                    onChange={(e) => setForm((s) => ({ ...s, maxReserveMismatchRatio: e.target.value }))}
                    placeholder="0.02"
                  />
                </label>
              </div>

              {error && <div className="form-error">{error}</div>}

              <div className="form-actions">
                <button className="btn btn-ghost" onClick={() => setMode("list")}>
                  Back
                </button>
                <button className="btn btn-primary" onClick={saveDraft}>
                  Save draft
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
