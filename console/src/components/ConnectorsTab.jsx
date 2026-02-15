import { useMemo, useState } from "react"

const normalizeId = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
}

const emptyConnector = {
  id: "",
  name: "",
  role: "primary",
  url: "",
  expectedSigner: "",
}

const formatInt = (value) => {
  if (value === null || value === undefined) return "--"
  const n = Number(value)
  if (!Number.isFinite(n)) return "--"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)
}

const formatUnix = (unixS) => {
  const n = Number(unixS)
  if (!Number.isFinite(n)) return "--"
  return new Date(n * 1000).toLocaleString()
}

const formatAge = (ageS) => {
  const n = Number(ageS)
  if (!Number.isFinite(n)) return "--"
  if (n < 60) return `${n}s`
  if (n < 3600) return `${Math.floor(n / 60)}m ${n % 60}s`
  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`
}

export default function ConnectorsTab({
  projectId,
  isLiveProject,
  draftConnectors,
  onSaveDraftConnectors,
  reserveRows,
  incident,
  incidentMessage,
  setIncidentMessage,
  onSetIncident,
  onClearIncident,
  busy,
}) {
  const [mode, setMode] = useState("create")
  const [editingOriginalId, setEditingOriginalId] = useState(null)
  const [form, setForm] = useState(emptyConnector)
  const [formError, setFormError] = useState("")
  const [testBusyId, setTestBusyId] = useState(null)

  const connectorsForProject = useMemo(() => {
    if (!projectId) return []
    return (draftConnectors || [])
      .filter((c) => c && typeof c.id === "string" && c.projectId === projectId)
      .slice()
      .sort((a, b) => {
        const ar = String(a.role || "")
        const br = String(b.role || "")
        if (ar < br) return -1
        if (ar > br) return 1
        return String(a.id).localeCompare(String(b.id))
      })
  }, [draftConnectors, projectId])

  const beginCreate = () => {
    setMode("create")
    setEditingOriginalId(null)
    setForm(emptyConnector)
    setFormError("")
  }

  const beginEdit = (connector) => {
    setMode("edit")
    setEditingOriginalId(connector?.id || null)
    setForm({
      id: connector?.id || "",
      name: connector?.name || "",
      role: connector?.role || "primary",
      url: connector?.url || "",
      expectedSigner: connector?.expectedSigner || "",
    })
    setFormError("")
  }

  const validate = () => {
    if (!projectId) return "Select a project first"

    const id = normalizeId(form.id)
    if (!id) return "Connector ID is required"
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
      return "Connector ID must be 2-63 chars: lowercase letters, numbers, hyphens"
    }

    if (!String(form.name || "").trim()) return "Connector name is required"
    if (!String(form.role || "").trim()) return "Role is required"
    if (!String(form.url || "").trim()) return "URL is required"

    const conflict = connectorsForProject.some((c) => normalizeId(c.id) === id)
    const isEditingSame = mode === "edit" && normalizeId(editingOriginalId) === id
    if (conflict && !isEditingSame) return "That connector ID already exists for this project"

    return ""
  }

  const saveConnector = () => {
    const msg = validate()
    if (msg) {
      setFormError(msg)
      return
    }

    const id = normalizeId(form.id)
    const next = {
      id,
      projectId,
      type: "http_reserve",
      name: String(form.name || "").trim(),
      role: String(form.role || "primary").trim(),
      url: String(form.url || "").trim(),
      expectedSigner: String(form.expectedSigner || "").trim(),
    }

    const all = Array.isArray(draftConnectors) ? draftConnectors.slice() : []

    if (mode === "edit" && editingOriginalId && normalizeId(editingOriginalId) !== id) {
      const filtered = all.filter((c) => !(c && c.projectId === projectId && normalizeId(c.id) === normalizeId(editingOriginalId)))
      onSaveDraftConnectors([...filtered, next])
    } else {
      const updated = all.map((c) => {
        if (!c) return c
        if (c.projectId !== projectId) return c
        if (normalizeId(c.id) !== id) return c
        return { ...c, ...next }
      })

      const exists = updated.some((c) => c && c.projectId === projectId && normalizeId(c.id) === id)
      onSaveDraftConnectors(exists ? updated : [...updated, next])
    }

    setFormError("")
    beginCreate()
  }

  const deleteConnector = (connectorId) => {
    if (!projectId) return
    const id = normalizeId(connectorId)
    const all = Array.isArray(draftConnectors) ? draftConnectors : []
    const next = all.filter((c) => !(c && c.projectId === projectId && normalizeId(c.id) === id))
    onSaveDraftConnectors(next)

    if (mode === "edit" && normalizeId(editingOriginalId) === id) {
      beginCreate()
    }
  }

  const updateConnector = (connectorId, patch) => {
    if (!projectId) return
    const id = normalizeId(connectorId)
    const all = Array.isArray(draftConnectors) ? draftConnectors : []
    const next = all.map((c) => {
      if (!c) return c
      if (c.projectId !== projectId) return c
      if (normalizeId(c.id) !== id) return c
      return { ...c, ...patch }
    })
    onSaveDraftConnectors(next)
  }

  const testConnection = async (connector) => {
    const id = normalizeId(connector?.id)
    if (!id || !connector?.url) return

    setTestBusyId(id)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)

    try {
      const res = await fetch(connector.url, {
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

      const expectedSigner = String(connector.expectedSigner || "").trim()
      if (expectedSigner) {
        const okSigner = String(signer || "").toLowerCase() === expectedSigner.toLowerCase()
        if (!okSigner) {
          throw new Error("Signer does not match expected signer")
        }
        if (!signature) {
          throw new Error("Response missing signature")
        }
      }

      updateConnector(id, {
        lastTestedAt: Date.now(),
        lastTestOk: true,
        lastTestMessage: `ok reserveUsd=${reserveUsd}${navUsd ? ` navUsd=${navUsd}` : ""} ts=${timestamp}${signer ? ` signer=${signer}` : ""}`,
      })
    } catch (err) {
      updateConnector(id, {
        lastTestedAt: Date.now(),
        lastTestOk: false,
        lastTestMessage: String(err?.message || err),
      })
    } finally {
      clearTimeout(timeout)
      setTestBusyId(null)
    }
  }

  return (
    <div className="tab-content">
      <h2 className="tab-title">Connectors</h2>
      <p className="tab-subtitle">Configure data sources and verify connectivity</p>

      {!projectId ? (
        <div className="card">
          <div className="empty-row">Select a project to manage connectors.</div>
        </div>
      ) : (
        <>
          <div className="detail-section">
            <h3 className="section-title">Configured Connectors (Local)</h3>
            <p className="tab-subtitle">These connectors are saved locally and used for export.</p>

            <div className="modal-split">
              <div className="modal-pane">
                <div className="pane-header">
                  <h4 className="pane-title">Connectors</h4>
                  <button className="btn btn-ghost" onClick={beginCreate}>
                    New
                  </button>
                </div>

                {connectorsForProject.length === 0 ? (
                  <div className="empty-state">No connectors yet. Create a primary and a secondary source.</div>
                ) : (
                  <div className="list compact">
                    {connectorsForProject.map((c) => (
                      <div
                        key={c.id}
                        className={`list-row ${mode === "edit" && normalizeId(editingOriginalId) === normalizeId(c.id) ? "active" : ""}`}
                      >
                        <button className="list-main" onClick={() => beginEdit(c)}>
                          <div className="list-title">{c.name || c.id}</div>
                          <div className="list-sub">
                            {c.role || "role"} · {c.url || "--"}
                            {typeof c.lastTestOk === "boolean" && (
                              <> · {c.lastTestOk ? "test ok" : "test failed"}</>
                            )}
                          </div>
                        </button>
                        <div className="list-actions">
                          <button
                            className="btn btn-ok"
                            disabled={testBusyId === normalizeId(c.id)}
                            onClick={() => void testConnection(c)}
                          >
                            {testBusyId === normalizeId(c.id) ? "Testing..." : "Test"}
                          </button>
                          <button className="btn btn-danger" onClick={() => deleteConnector(c.id)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="modal-pane">
                <div className="pane-header">
                  <h4 className="pane-title">{mode === "edit" ? "Edit Connector" : "Create Connector"}</h4>
                </div>

                <div className="form">
                  <div className="form-grid">
                    <div className="field">
                      <label className="field-label">Connector ID</label>
                      <input
                        className="text-input"
                        value={form.id}
                        onChange={(e) => setForm((p) => ({ ...p, id: e.target.value }))}
                        placeholder="source-a"
                      />
                    </div>

                    <div className="field">
                      <label className="field-label">Name</label>
                      <input
                        className="text-input"
                        value={form.name}
                        onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                        placeholder="Custodian API"
                      />
                    </div>

                    <div className="field">
                      <label className="field-label">Role</label>
                      <select
                        className="text-input"
                        value={form.role}
                        onChange={(e) => setForm((p) => ({ ...p, role: e.target.value }))}
                      >
                        <option value="primary">primary</option>
                        <option value="secondary">secondary</option>
                      </select>
                    </div>

                    <div className="field">
                      <label className="field-label">Expected signer (optional)</label>
                      <input
                        className="text-input"
                        value={form.expectedSigner}
                        onChange={(e) => setForm((p) => ({ ...p, expectedSigner: e.target.value }))}
                        placeholder="0x..."
                      />
                    </div>

                    <div className="field span-2">
                      <label className="field-label">URL</label>
                      <input
                        className="text-input"
                        value={form.url}
                        onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))}
                        placeholder="https://..."
                      />
                    </div>
                  </div>

                  {formError && <div className="form-error">{formError}</div>}

                  <div className="form-actions">
                    {mode === "edit" && (
                      <button className="btn btn-ghost" onClick={beginCreate}>
                        Cancel
                      </button>
                    )}
                    <button className="btn btn-primary" onClick={saveConnector}>
                      Save
                    </button>
                  </div>
                </div>

                {mode === "edit" && editingOriginalId && (
                  <div className="pane-footer">
                    {(() => {
                      const active = connectorsForProject.find((c) => normalizeId(c.id) === normalizeId(editingOriginalId))
                      if (!active || !active.lastTestedAt) return null
                      return (
                        <div className="empty-state">
                          Last test: {active.lastTestOk ? "ok" : "failed"} · {new Date(active.lastTestedAt).toLocaleString()}
                          {active.lastTestMessage ? ` · ${active.lastTestMessage}` : ""}
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="section-divider" />

          <div className="detail-section">
            <h3 className="section-title">Live Sources Status</h3>
            <p className="tab-subtitle">Observed data and incidents (only available for live projects).</p>

            <div className="card">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Reserve USD</th>
                    <th>NAV USD</th>
                    <th>Timestamp</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {isLiveProject && reserveRows.length ? (
                    reserveRows.map((row, idx) => (
                      <tr key={`${row.source || "source"}-${idx}`}>
                        <td>{row.source || "--"}</td>
                        <td>{formatInt(row.reserveUsd)}</td>
                        <td>{formatInt(row.navUsd)}</td>
                        <td>{formatUnix(row.timestamp)}</td>
                        <td>{formatAge(row.age)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="empty-row">
                        {isLiveProject ? "No reserve source data" : "Draft project: live status not available"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="section-divider" />

            <h3 className="section-title">Incident Feed</h3>
            <p className="tab-subtitle">Operator-triggered warnings and alerts</p>

            {incident?.active && (
              <div className={`incident-banner ${incident.severity === "critical" ? "critical" : "warning"}`}>
                <strong>[{incident.severity?.toUpperCase() || "WARNING"}]</strong> {incident.message || "No message"}
              </div>
            )}

            <div className="incident-controls">
              <input
                type="text"
                className="incident-input"
                placeholder="Incident message..."
                value={incidentMessage}
                onChange={(e) => setIncidentMessage(e.target.value)}
              />
              <div className="incident-buttons">
                <button className="btn btn-warn" disabled={busy || !isLiveProject} onClick={() => onSetIncident("warning")}>
                  Set Warning
                </button>
                <button className="btn btn-danger" disabled={busy || !isLiveProject} onClick={() => onSetIncident("critical")}>
                  Set Critical
                </button>
                <button className="btn btn-ghost" disabled={busy || !isLiveProject} onClick={onClearIncident}>
                  Clear
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
