import HeroSection from "./HeroSection"

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

export default function PublicStatusPage({
  projectId,
  projectName,
  status,
  busy,
  error,
  lastUpdatedAt,
  openConsoleHref,
  notFound,
}) {
  const derived = status?.derived || {}
  const onchain = status?.onchain || {}
  const receiver = onchain?.receiver || {}
  const token = onchain?.token || {}
  const enforcement = onchain?.enforcement || {}
  const links = status?.links || {}
  const reserves = status?.reserves || {}

  const statusValue = typeof derived.status === "string" ? derived.status : "STALE"

  const statusLine = (() => {
    if (notFound) return `Unknown project '${projectId}'`
    if (error) return error
    if (status?.onchain?.error) return `Onchain error: ${status.onchain.error}`
    return `Coverage ${formatInt(receiver.lastCoverageBps)} bps / min ${formatInt(receiver.minCoverageBps)} bps`
  })()

  const reasons = Array.isArray(derived.reasons) ? derived.reasons : []

  const reserveItems = [
    {
      label: "Primary",
      row: reserves?.primary,
      ageS: derived?.reserveAgesS?.primary,
    },
    {
      label: "Secondary",
      row: reserves?.secondary,
      ageS: derived?.reserveAgesS?.secondary,
    },
  ]

  const linkEntries = [
    ["Receiver", links?.receiver],
    ["Token", links?.token],
    ["Guardian", links?.guardian],
    ["Forwarder", links?.forwarder],
    ["Latest Tx", links?.lastTx],
  ].filter(([, url]) => typeof url === "string" && url.length)

  return (
    <div className="app">
      <div className="env-banner">
        <div className="env-banner-left">
          <span className="env-pill env-mode">Public status</span>
          <span className="env-label">{projectName || projectId || "--"}</span>
        </div>
        <div className="env-banner-right">
          <span className={`env-pill ${notFound ? "env-bad" : "env-ok"}`}>{notFound ? "Not found" : "Live"}</span>
          <a className="explorer-link" href={openConsoleHref}>
            Open console ↗
          </a>
        </div>
      </div>

      <HeroSection
        status={statusValue}
        statusLine={statusLine}
        coverageBps={receiver.lastCoverageBps}
        minCoverageBps={receiver.minCoverageBps}
        mintingPaused={receiver.mintingPaused}
        mintingEnabled={token.mintingEnabled}
        lastUpdatedAt={lastUpdatedAt}
        busy={busy}
        reasons={reasons}
      />

      <main className="main-content">
        <div className="tab-content">
          <div className="detail-section">
            <h3 className="section-title">Reserve Sources</h3>
            <div className="detail-grid">
              {reserveItems.map((item) => (
                <div key={item.label} className="detail-card">
                  <span className="detail-label">{item.label}</span>
                  <span className="detail-value">{formatInt(item.row?.reserveUsd)} USD</span>
                  <span className="detail-label">NAV</span>
                  <span className="detail-value">{formatInt(item.row?.navUsd)} USD</span>
                  <span className="detail-label">Age</span>
                  <span className="detail-value">{formatAge(item.ageS)}</span>
                  <span className="detail-label">Timestamp</span>
                  <span className="detail-value">{formatUnix(item.row?.timestamp)}</span>
                </div>
              ))}
              <div className="detail-card">
                <span className="detail-label">Mismatch ratio</span>
                <span className="detail-value">{derived?.reserveMismatchRatio ?? "--"}</span>
                <span className="detail-label">Max mismatch ratio</span>
                <span className="detail-value">{derived?.maxMismatchRatio ?? "--"}</span>
                <span className="detail-label">Max reserve age (s)</span>
                <span className="detail-value">{derived?.maxReserveAgeS ?? "--"}</span>
              </div>
            </div>
          </div>

          <div className="detail-section">
            <h3 className="section-title">Onchain Enforcement</h3>
            <div className="detail-grid">
              <div className="detail-card">
                <span className="detail-label">Hook wired</span>
                <span className="detail-value">{String(Boolean(enforcement.hookWired))}</span>
              </div>
              <div className="detail-card">
                <span className="detail-label">Forwarder set</span>
                <span className="detail-value">{String(Boolean(enforcement.forwarderSet))}</span>
              </div>
              <div className="detail-card">
                <span className="detail-label">Expected forwarder</span>
                <span className="detail-value mono">{enforcement.expectedForwarder || "--"}</span>
              </div>
              <div className="detail-card">
                <span className="detail-label">Matches expected</span>
                <span className="detail-value">{enforcement.forwarderMatchesExpected === null ? "--" : String(Boolean(enforcement.forwarderMatchesExpected))}</span>
              </div>
              <div className="detail-card">
                <span className="detail-label">Minting paused</span>
                <span className="detail-value">{receiver.mintingPaused === null || receiver.mintingPaused === undefined ? "--" : String(Boolean(receiver.mintingPaused))}</span>
              </div>
              <div className="detail-card">
                <span className="detail-label">Token minting enabled</span>
                <span className="detail-value">{token.mintingEnabled === null || token.mintingEnabled === undefined ? "--" : String(Boolean(token.mintingEnabled))}</span>
              </div>
            </div>
          </div>

          {linkEntries.length > 0 && (
            <div className="detail-section">
              <h3 className="section-title">Explorer Links</h3>
              <div className="links-row">
                {linkEntries.map(([label, url]) => (
                  <a key={label} href={url} target="_blank" rel="noreferrer" className="explorer-link">
                    {label} ↗
                  </a>
                ))}
              </div>
            </div>
          )}

          {onchain?.error && (
            <div className="error-banner">
              <strong>RPC Error:</strong> {onchain.error}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
