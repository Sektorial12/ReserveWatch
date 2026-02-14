const healthClassByStatus = {
  HEALTHY: "hero-healthy",
  DEGRADED: "hero-degraded",
  STALE: "hero-stale",
  UNHEALTHY: "hero-unhealthy",
}

export default function HeroSection({
  status,
  statusLine,
  coverageBps,
  minCoverageBps,
  mintingPaused,
  mintingEnabled,
  lastUpdatedAt,
  busy,
  reasons,
}) {
  const healthClass = healthClassByStatus[status] || "hero-stale"

  const formatInt = (value) => {
    if (value === null || value === undefined) return "--"
    const n = Number(value)
    if (!Number.isFinite(n)) return "--"
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)
  }

  const heroCards = [
    {
      label: "Coverage",
      value: `${formatInt(coverageBps)} bps`,
      sub: `min ${formatInt(minCoverageBps)} bps`,
    },
    {
      label: "Minting",
      value: mintingPaused === true ? "PAUSED" : mintingPaused === false ? "ACTIVE" : "--",
      sub: mintingEnabled === true ? "token enabled" : mintingEnabled === false ? "token disabled" : "",
    },
    {
      label: "Enforcement",
      value: mintingEnabled === false || mintingPaused === true ? "TRIGGERED" : "CLEAR",
      sub: "circuit breaker",
    },
  ]

  return (
    <section className="hero-section">
      <div className="hero-main">
        <div className={`hero-badge ${healthClass}`}>
          <span className="hero-dot" />
          <span className="hero-status">{status}</span>
        </div>
        <p className="hero-line">{statusLine}</p>
        <div className="hero-meta">
          <span>{busy ? "syncing..." : "live"}</span>
          <span>{lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString() : "--"}</span>
        </div>
      </div>

      <div className="hero-cards">
        {heroCards.map((card) => (
          <article key={card.label} className="hero-card">
            <p className="hero-card-label">{card.label}</p>
            <strong className="hero-card-value">{card.value}</strong>
            {card.sub && <span className="hero-card-sub">{card.sub}</span>}
          </article>
        ))}
      </div>

      {reasons && reasons.length > 0 && (
        <div className="hero-reasons">
          {reasons.map((reason) => (
            <span key={reason} className="reason-chip">
              {reason}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
