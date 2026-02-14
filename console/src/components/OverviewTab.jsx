const formatInt = (value) => {
  if (value === null || value === undefined) return "--"
  const n = Number(value)
  if (!Number.isFinite(n)) return "--"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)
}

const formatAge = (ageS) => {
  const n = Number(ageS)
  if (!Number.isFinite(n)) return "--"
  if (n < 60) return `${n}s`
  if (n < 3600) return `${Math.floor(n / 60)}m ${n % 60}s`
  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`
}

export default function OverviewTab({ derived, receiver, token, mode }) {
  const primaryAge = derived?.reserveAgesS?.primary
  const secondaryAge = derived?.reserveAgesS?.secondary
  const worstAge = Math.max(Number(primaryAge) || 0, Number(secondaryAge) || 0)

  const kpis = [
    { label: "Reserve mode", value: mode || "--" },
    { label: "Data freshness", value: worstAge ? `worst ${formatAge(worstAge)}` : "--" },
    { label: "Source agreement", value: derived?.sourceMismatch ? "MISMATCH" : "aligned" },
    { label: "Coverage bps", value: formatInt(receiver?.lastCoverageBps) },
    { label: "Min coverage", value: formatInt(receiver?.minCoverageBps) },
    { label: "Reserve USD", value: formatInt(receiver?.lastReserveUsd) },
    { label: "NAV USD", value: formatInt(receiver?.lastNavUsd) },
    { label: "Liability supply", value: formatInt(receiver?.lastLiabilitySupply) },
  ]

  return (
    <div className="tab-content">
      <h2 className="tab-title">Overview</h2>
      <p className="tab-subtitle">Key metrics and current state summary</p>

      <div className="kpi-grid">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="kpi-card">
            <span className="kpi-label">{kpi.label}</span>
            <span className="kpi-value">{kpi.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
