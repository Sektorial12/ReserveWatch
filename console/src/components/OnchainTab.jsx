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

const asText = (value) => {
  if (value === null || value === undefined || value === "") return "--"
  return String(value)
}

export default function OnchainTab({ onchain, links }) {
  const receiver = onchain?.receiver || {}
  const token = onchain?.token || {}
  const enforcement = onchain?.enforcement || {}

  const receiverDetails = [
    { label: "Receiver address", value: onchain?.receiverAddress },
    { label: "Attestation hash", value: receiver.lastAttestationHash },
    { label: "Reserve USD", value: formatInt(receiver.lastReserveUsd) },
    { label: "NAV USD", value: formatInt(receiver.lastNavUsd) },
    { label: "Liability supply", value: formatInt(receiver.lastLiabilitySupply) },
    { label: "Coverage bps", value: formatInt(receiver.lastCoverageBps) },
    { label: "Min coverage bps", value: formatInt(receiver.minCoverageBps) },
    { label: "asOf timestamp", value: formatUnix(receiver.lastAsOfTimestamp) },
    { label: "Minting paused", value: asText(receiver.mintingPaused) },
    { label: "Forwarder", value: receiver.forwarderAddress },
  ]

  const tokenDetails = [
    { label: "Token address", value: onchain?.liabilityTokenAddress },
    { label: "Total supply", value: formatInt(token.totalSupply) },
    { label: "Minting enabled", value: asText(token.mintingEnabled) },
    { label: "Guardian", value: token.guardian },
  ]

  const enforcementDetails = [
    { label: "Hook wired", value: asText(enforcement.hookWired) },
    { label: "Forwarder set", value: asText(enforcement.forwarderSet) },
    { label: "Expected forwarder", value: enforcement.expectedForwarder || "--" },
    { label: "Forwarder matches", value: asText(enforcement.forwarderMatchesExpected) },
  ]

  const linkEntries = [
    ["Receiver", links?.receiver],
    ["Token", links?.token],
    ["Guardian", links?.guardian],
    ["Forwarder", links?.forwarder],
    ["Latest Tx", links?.lastTx],
  ].filter(([, url]) => typeof url === "string" && url.length)

  return (
    <div className="tab-content">
      <h2 className="tab-title">Onchain State</h2>
      <p className="tab-subtitle">Receiver and token contract state from Sepolia</p>

      <div className="detail-section">
        <h3 className="section-title">Receiver Contract</h3>
        <div className="detail-grid">
          {receiverDetails.map((item) => (
            <div key={item.label} className="detail-card">
              <span className="detail-label">{item.label}</span>
              <span className="detail-value">{asText(item.value)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h3 className="section-title">Liability Token</h3>
        <div className="detail-grid">
          {tokenDetails.map((item) => (
            <div key={item.label} className="detail-card">
              <span className="detail-label">{item.label}</span>
              <span className="detail-value">{asText(item.value)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h3 className="section-title">Enforcement Wiring</h3>
        <div className="detail-grid">
          {enforcementDetails.map((item) => (
            <div key={item.label} className="detail-card">
              <span className="detail-label">{item.label}</span>
              <span className="detail-value">{asText(item.value)}</span>
            </div>
          ))}
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
  )
}
