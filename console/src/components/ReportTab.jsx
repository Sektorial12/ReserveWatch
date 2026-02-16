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

export default function ReportTab({ projectId, isLiveProject, status, history, historyMeta }) {
  if (!projectId) {
    return (
      <div className="tab-content">
        <h2 className="tab-title">Report</h2>
        <p className="tab-subtitle">Proof-of-reserves report and export</p>
        <div className="card">
          <div className="empty-row">Select a project to generate a report.</div>
        </div>
      </div>
    )
  }

  if (!isLiveProject) {
    return (
      <div className="tab-content">
        <h2 className="tab-title">Report</h2>
        <p className="tab-subtitle">Proof-of-reserves report and export</p>
        <div className="card">
          <div className="empty-row">Reports are available for live projects only.</div>
        </div>
      </div>
    )
  }

  const derived = status?.derived || {}
  const reserves = status?.reserves || {}
  const onchain = status?.onchain || {}
  const receiver = onchain?.receiver || {}
  const token = onchain?.token || {}
  const links = status?.links || {}

  const nowIso = new Date().toISOString()
  const statusValue = typeof derived.status === "string" ? derived.status : "STALE"
  const reasons = Array.isArray(derived.reasons) ? derived.reasons : []

  const reserveItems = [
    { label: "Primary", row: reserves?.primary },
    { label: "Secondary", row: reserves?.secondary },
  ]

  const linkEntries = [
    ["Receiver", links?.receiver],
    ["Token", links?.token],
    ["Guardian", links?.guardian],
    ["Forwarder", links?.forwarder],
    ["Latest Tx", links?.lastTx],
  ].filter(([, url]) => typeof url === "string" && url.length)

  const latestEvent = Array.isArray(history) && history.length ? history[0] : null

  const exportReportJson = () => {
    const payload = {
      generatedAt: nowIso,
      project: {
        id: projectId,
        name: status?.onchain?.project?.name || null,
      },
      mode: status?.mode || null,
      derived,
      reserves,
      onchain,
      links,
      history: {
        meta: historyMeta || null,
        events: Array.isArray(history) ? history : [],
      },
    }

    downloadText(`reservewatch-report-${projectId}.json`, JSON.stringify(payload, null, 2))
  }

  const exportHistoryCsv = () => {
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
      ...(Array.isArray(history) ? history : []).map((e) => [
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

  return (
    <div className="tab-content">
      <h2 className="tab-title">Report</h2>
      <p className="tab-subtitle">Proof-of-reserves snapshot for sharing and export</p>

      <div className="detail-section">
        <div className="form-actions">
          <button className="btn btn-ghost" onClick={() => window.print()}>
            Print
          </button>
          <button className="btn btn-ghost" onClick={exportHistoryCsv}>
            Export audit CSV
          </button>
          <button className="btn btn-primary" onClick={exportReportJson}>
            Download report JSON
          </button>
        </div>
      </div>

      <div className="detail-section">
        <h3 className="section-title">Summary</h3>
        <div className="detail-grid">
          <div className="detail-card">
            <span className="detail-label">Generated at</span>
            <span className="detail-value">{nowIso}</span>
          </div>
          <div className="detail-card">
            <span className="detail-label">Status</span>
            <span className="detail-value">{statusValue}</span>
          </div>
          <div className="detail-card">
            <span className="detail-label">Coverage bps</span>
            <span className="detail-value">{formatInt(receiver.lastCoverageBps)}</span>
          </div>
          <div className="detail-card">
            <span className="detail-label">Min coverage bps</span>
            <span className="detail-value">{formatInt(receiver.minCoverageBps)}</span>
          </div>
          <div className="detail-card">
            <span className="detail-label">Minting paused</span>
            <span className="detail-value">{receiver.mintingPaused === null || receiver.mintingPaused === undefined ? "--" : String(Boolean(receiver.mintingPaused))}</span>
          </div>
          <div className="detail-card">
            <span className="detail-label">Token minting enabled</span>
            <span className="detail-value">{token.mintingEnabled === null || token.mintingEnabled === undefined ? "--" : String(Boolean(token.mintingEnabled))}</span>
          </div>
          <div className="detail-card">
            <span className="detail-label">Last onchain attestation</span>
            <span className="detail-value">{latestEvent?.transactionHash ? "available" : "--"}</span>
          </div>
          <div className="detail-card">
            <span className="detail-label">Latest asOf</span>
            <span className="detail-value">{latestEvent?.asOfTimestamp ? formatUnix(latestEvent.asOfTimestamp) : "--"}</span>
          </div>
        </div>

        {reasons.length > 0 && (
          <div className="detail-section">
            <h3 className="section-title">Reasons</h3>
            <div className="card">
              <div className="empty-row">{reasons.join(", ")}</div>
            </div>
          </div>
        )}
      </div>

      <div className="detail-section">
        <h3 className="section-title">Reserve Sources</h3>
        <div className="detail-grid">
          {reserveItems.map((item) => (
            <div key={item.label} className="detail-card">
              <span className="detail-label">{item.label}</span>
              <span className="detail-value">{formatInt(item.row?.reserveUsd)} USD</span>
              <span className="detail-label">NAV USD</span>
              <span className="detail-value">{formatInt(item.row?.navUsd)} USD</span>
              <span className="detail-label">Timestamp</span>
              <span className="detail-value">{item.row?.timestamp ? formatUnix(item.row.timestamp) : "--"}</span>
              <span className="detail-label">Signer</span>
              <span className="detail-value">{item.row?.signer || "--"}</span>
              <span className="detail-label">Signature valid</span>
              <span className="detail-value">
                {item.row?.signatureValid === null || item.row?.signatureValid === undefined
                  ? "--"
                  : item.row.signatureValid
                    ? "true"
                    : "false"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {linkEntries.length > 0 && (
        <div className="detail-section">
          <h3 className="section-title">Onchain Proof Links</h3>
          <div className="links-row">
            {linkEntries.map(([label, url]) => (
              <a key={label} href={url} target="_blank" rel="noreferrer" className="explorer-link">
                {label} ↗
              </a>
            ))}
          </div>
        </div>
      )}

      {historyMeta?.error && (
        <div className="error-banner">
          <strong>History Error:</strong> {historyMeta.error}
        </div>
      )}
      {onchain?.error && (
        <div className="error-banner">
          <strong>RPC Error:</strong> {onchain.error}
        </div>
      )}
    </div>
  )
}
