import { useMemo, useState } from "react"

const asText = (value) => {
  if (value === null || value === undefined || value === "") return ""
  return String(value)
}

const formatMaybe = (value) => {
  if (value === null || value === undefined || value === "") return "--"
  return String(value)
}

const formatTime = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return "--"
  return new Date(n).toLocaleString()
}

const severityLabel = (severity) => {
  if (severity === "critical") return "Critical"
  if (severity === "warning") return "Warning"
  return "Info"
}

export default function AlertsTab({
  projectId,
  isLiveProject,
  serverIncident,
  routing,
  onSaveRouting,
  rules,
  onSaveRules,
  incidents,
  onAcknowledge,
  onSnooze,
  onResolve,
  onReopen,
  onClearResolved,
  busy,
}) {
  const [testState, setTestState] = useState(null)
  const [testError, setTestError] = useState("")

  const sortedIncidents = useMemo(() => {
    const arr = Array.isArray(incidents) ? incidents.filter(Boolean) : []
    return arr.slice().sort((a, b) => {
      const at = Number(a?.updatedAt || a?.createdAt || 0)
      const bt = Number(b?.updatedAt || b?.createdAt || 0)
      return bt - at
    })
  }, [incidents])

  const effectiveRules = rules || {}
  const effectiveRouting = routing || {}

  const sendTest = async () => {
    setTestError("")
    setTestState("sending")

    const text = `ReserveWatch test alert${projectId ? ` for ${projectId}` : ""}`

    try {
      if (effectiveRouting?.enableOutbound && effectiveRouting?.slackWebhookUrl) {
        await fetch(effectiveRouting.slackWebhookUrl, {
          method: "POST",
          mode: "no-cors",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ text }),
        })
      }

      if (effectiveRouting?.enableOutbound && effectiveRouting?.discordWebhookUrl) {
        await fetch(effectiveRouting.discordWebhookUrl, {
          method: "POST",
          mode: "no-cors",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ content: text }),
        })
      }

      setTestState("sent")
    } catch (err) {
      setTestState("error")
      setTestError(String(err?.message || err))
    }
  }

  return (
    <div className="tab-content">
      <h2 className="tab-title">Alerts & Incidents</h2>
      <p className="tab-subtitle">Local-first rules and an incident inbox derived from monitor reason codes</p>

      <div className="detail-section">
        <h3 className="section-title">Routing (Local)</h3>
        <p className="tab-subtitle">Saved in this browser. Outbound webhooks may be blocked by CORS depending on your provider.</p>

        <div className="card">
          <div className="form">
            <div className="form-grid">
              <label className="field span-2">
                <span className="field-label">Enable outbound webhooks</span>
                <select
                  className="text-input"
                  value={effectiveRouting.enableOutbound ? "yes" : "no"}
                  onChange={(e) => onSaveRouting({ ...effectiveRouting, enableOutbound: e.target.value === "yes" })}
                  disabled={busy}
                >
                  <option value="no">No (inbox only)</option>
                  <option value="yes">Yes</option>
                </select>
              </label>

              <label className="field span-2">
                <span className="field-label">Slack webhook URL</span>
                <input
                  className="text-input"
                  value={asText(effectiveRouting.slackWebhookUrl)}
                  onChange={(e) => onSaveRouting({ ...effectiveRouting, slackWebhookUrl: e.target.value })}
                  placeholder="https://hooks.slack.com/services/..."
                  disabled={busy}
                />
              </label>

              <label className="field span-2">
                <span className="field-label">Discord webhook URL</span>
                <input
                  className="text-input"
                  value={asText(effectiveRouting.discordWebhookUrl)}
                  onChange={(e) => onSaveRouting({ ...effectiveRouting, discordWebhookUrl: e.target.value })}
                  placeholder="https://discord.com/api/webhooks/..."
                  disabled={busy}
                />
              </label>
            </div>

            <div className="form-actions">
              <button className="btn btn-ghost" disabled={busy} onClick={() => onSaveRouting({ enableOutbound: false, slackWebhookUrl: "", discordWebhookUrl: "" })}>
                Clear
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void sendTest()}>
                {testState === "sending" ? "Sending..." : "Send test"}
              </button>
            </div>

            {testError && <div className="form-error">{testError}</div>}
            {testState === "sent" && <div className="empty-row">Test dispatched.</div>}
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3 className="section-title">Alert Rules (Local)</h3>
        <p className="tab-subtitle">Rules map monitor reason codes to incidents. Incidents are deduped with a short cooldown.</p>

        <div className="card">
          <div className="form">
            <div className="form-grid">
              <label className="field span-2">
                <span className="field-label">Coverage breach</span>
                <select
                  className="text-input"
                  value={effectiveRules.coverageBreach ? "on" : "off"}
                  onChange={(e) => onSaveRules({ ...effectiveRules, coverageBreach: e.target.value === "on" })}
                  disabled={busy}
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>

              <label className="field span-2">
                <span className="field-label">Source stale</span>
                <select
                  className="text-input"
                  value={effectiveRules.sourceStale ? "on" : "off"}
                  onChange={(e) => onSaveRules({ ...effectiveRules, sourceStale: e.target.value === "on" })}
                  disabled={busy}
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>

              <label className="field span-2">
                <span className="field-label">Source mismatch</span>
                <select
                  className="text-input"
                  value={effectiveRules.sourceMismatch ? "on" : "off"}
                  onChange={(e) => onSaveRules({ ...effectiveRules, sourceMismatch: e.target.value === "on" })}
                  disabled={busy}
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>

              <label className="field span-2">
                <span className="field-label">RPC / read failures</span>
                <select
                  className="text-input"
                  value={effectiveRules.rpcFailures ? "on" : "off"}
                  onChange={(e) => onSaveRules({ ...effectiveRules, rpcFailures: e.target.value === "on" })}
                  disabled={busy}
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
            </div>

            <div className="form-actions">
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => onSaveRules({ coverageBreach: true, sourceStale: true, sourceMismatch: true, rpcFailures: true })}
              >
                Reset defaults
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3 className="section-title">Server Incident</h3>
        <p className="tab-subtitle">This is the live-project server incident banner (not available for drafts).</p>

        {!projectId ? (
          <div className="card">
            <div className="empty-row">Select a project to view incident state.</div>
          </div>
        ) : !isLiveProject ? (
          <div className="card">
            <div className="empty-row">Draft project selected. Server incidents are not available.</div>
          </div>
        ) : serverIncident?.active ? (
          <div className={`incident-banner ${serverIncident.severity === "critical" ? "critical" : "warning"}`}>
            <strong>[{serverIncident.severity?.toUpperCase() || "WARNING"}]</strong> {serverIncident.message || "No message"}
          </div>
        ) : (
          <div className="card">
            <div className="empty-row">No active server incident.</div>
          </div>
        )}
      </div>

      <div className="detail-section">
        <h3 className="section-title">Incident Inbox (Local)</h3>
        <p className="tab-subtitle">Auto-generated incidents from derived reason codes and your alert rules.</p>

        <div className="card">
          <div className="form-actions">
            <button className="btn btn-ghost" disabled={busy} onClick={onClearResolved}>
              Clear resolved
            </button>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>Updated</th>
                <th>Project</th>
                <th>Severity</th>
                <th>Reason</th>
                <th>State</th>
                <th>Count</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedIncidents.length ? (
                sortedIncidents.map((inc) => (
                  <tr key={inc.id}>
                    <td>{formatTime(inc.updatedAt || inc.createdAt)}</td>
                    <td>{formatMaybe(inc.projectId)}</td>
                    <td>{severityLabel(inc.severity)}</td>
                    <td>{formatMaybe(inc.reason)}</td>
                    <td>
                      {inc.state === "snoozed" && inc.snoozedUntil ? `snoozed until ${formatTime(inc.snoozedUntil)}` : formatMaybe(inc.state)}
                    </td>
                    <td>{formatMaybe(inc.count)}</td>
                    <td>
                      <div className="incident-buttons">
                        {inc.state !== "ack" && inc.state !== "resolved" && (
                          <button className="btn btn-warn" disabled={busy} onClick={() => onAcknowledge(inc.id)}>
                            Ack
                          </button>
                        )}
                        {inc.state !== "snoozed" && inc.state !== "resolved" && (
                          <button className="btn btn-ghost" disabled={busy} onClick={() => onSnooze(inc.id)}>
                            Snooze
                          </button>
                        )}
                        {inc.state !== "resolved" ? (
                          <button className="btn btn-danger" disabled={busy} onClick={() => onResolve(inc.id)}>
                            Resolve
                          </button>
                        ) : (
                          <button className="btn btn-ghost" disabled={busy} onClick={() => onReopen(inc.id)}>
                            Reopen
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="empty-row">
                    No incidents yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
