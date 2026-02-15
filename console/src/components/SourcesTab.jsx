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

export default function SourcesTab({
  reserveRows,
  incident,
  incidentMessage,
  setIncidentMessage,
  onSetIncident,
  onClearIncident,
  busy,
}) {
  return (
    <div className="tab-content">
      <h2 className="tab-title">Connectors</h2>
      <p className="tab-subtitle">Connected data sources and incident feed</p>

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
            {reserveRows.length ? (
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
                  No reserve source data
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
          <button
            className="btn btn-warn"
            disabled={busy}
            onClick={() => onSetIncident("warning")}
          >
            Set Warning
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => onSetIncident("critical")}
          >
            Set Critical
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={onClearIncident}>
            Clear
          </button>
        </div>
      </div>
    </div>
  )
}
