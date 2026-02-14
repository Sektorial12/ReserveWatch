export default function SettingsTab({
  derived,
  interfaces,
  operator,
  mode,
  onSetMode,
  busy,
}) {
  const asText = (value) => {
    if (value === null || value === undefined || value === "") return "--"
    return String(value)
  }

  const policyItems = [
    { label: "Max reserve age (s)", value: derived?.maxReserveAgeS },
    { label: "Max mismatch ratio", value: derived?.maxMismatchRatio },
    { label: "Min coverage bps", value: derived?.minCoverageBps },
  ]

  const interfaceItems = [
    {
      label: "Policy setter",
      value: `${asText(interfaces?.policy?.contract)}.${asText(interfaces?.policy?.function)}`,
    },
    {
      label: "Report receiver",
      value: `${asText(interfaces?.reportReceiver?.contract)}.${asText(interfaces?.reportReceiver?.function)}`,
    },
    {
      label: "Enforcement hook",
      value: `${asText(interfaces?.enforcementHook?.contract)}.${asText(interfaces?.enforcementHook?.function)}`,
    },
  ]

  const recommendations =
    Array.isArray(operator?.recommendedActions) && operator.recommendedActions.length
      ? operator.recommendedActions
      : []

  return (
    <div className="tab-content">
      <h2 className="tab-title">Settings & Policy</h2>
      <p className="tab-subtitle">Configuration and operational context</p>

      <div className="detail-section">
        <h3 className="section-title">Policy Parameters</h3>
        <div className="detail-grid">
          {policyItems.map((item) => (
            <div key={item.label} className="detail-card">
              <span className="detail-label">{item.label}</span>
              <span className="detail-value">{asText(item.value)}</span>
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

      <div className="detail-section">
        <h3 className="section-title">Demo Controls</h3>
        <p className="tab-subtitle">Hackathon-only. Remove for production.</p>

        <div className="demo-controls">
          <span className="demo-mode">Current mode: <strong>{mode || "--"}</strong></span>
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
    </div>
  )
}
