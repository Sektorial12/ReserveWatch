import { useMemo, useState } from "react"

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

const toCsv = (rows) => {
  const esc = (value) => {
    const v = value === null || value === undefined ? "" : String(value)
    if (/[\n\r,\"]/g.test(v)) return `"${v.replace(/\"/g, '""')}"`
    return v
  }

  return rows.map((row) => row.map(esc).join(",")).join("\n")
}

const deltaText = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return "--"
  const abs = Math.abs(n)
  const sign = n > 0 ? "+" : "-"
  return `${sign}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(abs)}`
}

export default function HistoryTab({ projectId, isLiveProject, history, historyMeta }) {
  const [range, setRange] = useState("7d")

  const filtered = useMemo(() => {
    const events = Array.isArray(history) ? history : []
    const nowS = Math.floor(Date.now() / 1000)
    const limitS =
      range === "1h" ? 3600 :
      range === "24h" ? 86400 :
      range === "7d" ? 604800 :
      null

    const base = limitS ? events.filter((e) => {
      const ts = Number(e?.asOfTimestamp)
      if (!Number.isFinite(ts)) return false
      return ts >= nowS - limitS
    }) : events

    return base
  }, [history, range])

  const rowsWithDiff = useMemo(() => {
    return filtered.map((evt, idx) => {
      const prev = filtered[idx + 1] || null

      const dCoverage = prev ? Number(evt?.coverageBps) - Number(prev?.coverageBps) : null
      const dReserve = prev ? Number(evt?.reserveUsd) - Number(prev?.reserveUsd) : null
      const dNav = prev ? Number(evt?.navUsd) - Number(prev?.navUsd) : null
      const breakerChanged = prev ? evt?.breakerTriggered !== prev?.breakerTriggered : null

      return {
        evt,
        diff: {
          dCoverage: Number.isFinite(dCoverage) ? dCoverage : null,
          dReserve: Number.isFinite(dReserve) ? dReserve : null,
          dNav: Number.isFinite(dNav) ? dNav : null,
          breakerChanged,
        },
      }
    })
  }, [filtered])

  const exportJson = () => {
    if (!projectId) return
    const payload = {
      generatedAt: new Date().toISOString(),
      projectId,
      range,
      meta: historyMeta || null,
      events: filtered,
    }
    downloadText(`reservewatch-audit-${projectId}.json`, JSON.stringify(payload, null, 2))
  }

  const exportCsv = () => {
    if (!projectId) return
    const rows = [
      [
        "asOfTimestamp",
        "coverageBps",
        "breakerTriggered",
        "reserveUsd",
        "navUsd",
        "liabilitySupply",
        "transactionHash",
        "txUrl",
      ],
      ...filtered.map((e) => [
        e?.asOfTimestamp ?? "",
        e?.coverageBps ?? "",
        e?.breakerTriggered ?? "",
        e?.reserveUsd ?? "",
        e?.navUsd ?? "",
        e?.liabilitySupply ?? "",
        e?.transactionHash ?? "",
        e?.txUrl ?? "",
      ]),
    ]
    downloadText(`reservewatch-audit-${projectId}.csv`, toCsv(rows), "text/csv")
  }

  if (!projectId) {
    return (
      <div className="tab-content">
        <h2 className="tab-title">Audit</h2>
        <p className="tab-subtitle">Recent attestation events and onchain proof trail</p>

        <div className="card">
          <div className="empty-row">Select a project to view audit history.</div>
        </div>
      </div>
    )
  }

  if (!isLiveProject) {
    return (
      <div className="tab-content">
        <h2 className="tab-title">Audit</h2>
        <p className="tab-subtitle">Recent attestation events and onchain proof trail</p>

        <div className="card">
          <div className="empty-row">Audit history is available for live projects only.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="tab-content">
      <h2 className="tab-title">Audit</h2>
      <p className="tab-subtitle">Recent attestation events and onchain proof trail</p>

      <div className="detail-section">
        <div className="form">
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Time range</span>
              <select className="text-input" value={range} onChange={(e) => setRange(e.target.value)}>
                <option value="1h">Last hour</option>
                <option value="24h">Last 24h</option>
                <option value="7d">Last 7d</option>
                <option value="all">All fetched</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">Events</span>
              <input className="text-input" value={String(filtered.length)} readOnly />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={exportCsv}>
              Export CSV
            </button>
            <button className="btn btn-primary" onClick={exportJson}>
              Export JSON
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Coverage</th>
              <th>Δ Coverage</th>
              <th>Breaker</th>
              <th>Δ Breaker</th>
              <th>Reserve USD</th>
              <th>Δ Reserve</th>
              <th>NAV USD</th>
              <th>Δ NAV</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {rowsWithDiff.length ? (
              rowsWithDiff.map(({ evt, diff }, idx) => (
                <tr key={evt.transactionHash || idx}>
                  <td>{formatUnix(evt.asOfTimestamp)}</td>
                  <td>{formatInt(evt.coverageBps)} bps</td>
                  <td>{diff.dCoverage === null ? "--" : `${deltaText(diff.dCoverage)} bps`}</td>
                  <td className={evt.breakerTriggered ? "text-danger" : "text-ok"}>
                    {evt.breakerTriggered === true ? "YES" : evt.breakerTriggered === false ? "NO" : "--"}
                  </td>
                  <td>
                    {diff.breakerChanged === null ? "--" : diff.breakerChanged ? "changed" : "--"}
                  </td>
                  <td>{formatInt(evt.reserveUsd)}</td>
                  <td>{diff.dReserve === null ? "--" : `${deltaText(diff.dReserve)}`}</td>
                  <td>{formatInt(evt.navUsd)}</td>
                  <td>{diff.dNav === null ? "--" : `${deltaText(diff.dNav)}`}</td>
                  <td>
                    {evt.txUrl ? (
                      <a href={evt.txUrl} target="_blank" rel="noreferrer" className="tx-link">
                        View ↗
                      </a>
                    ) : (
                      "--"
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={10} className="empty-row">
                  No attestation events found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {historyMeta?.error && (
        <div className="error-banner">
          <strong>History Error:</strong> {historyMeta.error}
        </div>
      )}
    </div>
  )
}
