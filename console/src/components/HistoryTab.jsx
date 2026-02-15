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

export default function HistoryTab({ history }) {
  return (
    <div className="tab-content">
      <h2 className="tab-title">Audit</h2>
      <p className="tab-subtitle">Recent attestation events and onchain proof trail</p>

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Coverage</th>
              <th>Breaker</th>
              <th>Reserve USD</th>
              <th>NAV USD</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {history.length ? (
              history.map((evt, idx) => (
                <tr key={evt.transactionHash || idx}>
                  <td>{formatUnix(evt.asOfTimestamp)}</td>
                  <td>{formatInt(evt.coverageBps)} bps</td>
                  <td className={evt.breakerTriggered ? "text-danger" : "text-ok"}>
                    {evt.breakerTriggered === true ? "YES" : evt.breakerTriggered === false ? "NO" : "--"}
                  </td>
                  <td>{formatInt(evt.reserveUsd)}</td>
                  <td>{formatInt(evt.navUsd)}</td>
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
                <td colSpan={6} className="empty-row">
                  No attestation events found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
