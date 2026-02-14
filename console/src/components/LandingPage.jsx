export default function LandingPage({ onEnterDashboard }) {
  return (
    <div className="landing">
      <div className="landing-bg" />
      
      <header className="landing-header">
        <div className="landing-logo">
          <span className="logo-icon">◈</span>
          <span className="logo-text">ReserveWatch</span>
        </div>
        <span className="landing-badge">Chainlink CRE Hackathon 2026</span>
      </header>

      <main className="landing-hero">
        <h1 className="landing-title">
          Real-Time Proof of Reserves
          <span className="title-accent"> with Onchain Enforcement</span>
        </h1>
        
        <p className="landing-subtitle">
          Automated reserve monitoring and circuit breaker enforcement for tokenized assets, 
          powered by Chainlink's Compute Runtime Environment (CRE).
        </p>

        <button className="landing-cta" onClick={onEnterDashboard}>
          Enter Dashboard
          <span className="cta-arrow">→</span>
        </button>
      </main>

      <section className="landing-features">
        <div className="feature-card">
          <div className="feature-icon">📊</div>
          <h3>Multi-Source Verification</h3>
          <p>Aggregate reserve data from multiple independent sources with cryptographic signature verification.</p>
        </div>
        
        <div className="feature-card">
          <div className="feature-icon">⚡</div>
          <h3>CRE-Powered Workflow</h3>
          <p>Chainlink CRE fetches offchain reserves, computes coverage ratios, and writes attestations onchain.</p>
        </div>
        
        <div className="feature-card">
          <div className="feature-icon">🛡️</div>
          <h3>Automatic Circuit Breaker</h3>
          <p>If reserves fall below threshold, minting is automatically paused to protect token holders.</p>
        </div>
      </section>

      <section className="landing-how">
        <h2>How It Works</h2>
        <div className="how-steps">
          <div className="how-step">
            <div className="step-number">1</div>
            <div className="step-content">
              <h4>Fetch Reserves</h4>
              <p>CRE workflow fetches reserve balances from custodian APIs every 60 seconds</p>
            </div>
          </div>
          <div className="how-connector" />
          <div className="how-step">
            <div className="step-number">2</div>
            <div className="step-content">
              <h4>Compute Coverage</h4>
              <p>Calculate coverage ratio: (reserves / liabilities) in basis points</p>
            </div>
          </div>
          <div className="how-connector" />
          <div className="how-step">
            <div className="step-number">3</div>
            <div className="step-content">
              <h4>Attest Onchain</h4>
              <p>Signed attestation written to ReserveWatchReceiver contract on Sepolia</p>
            </div>
          </div>
          <div className="how-connector" />
          <div className="how-step">
            <div className="step-number">4</div>
            <div className="step-content">
              <h4>Enforce Policy</h4>
              <p>If coverage &lt; threshold, circuit breaker pauses token minting</p>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-stack">
        <h2>Tech Stack</h2>
        <div className="stack-items">
          <div className="stack-item">
            <strong>Chainlink CRE</strong>
            <span>Compute Runtime Environment</span>
          </div>
          <div className="stack-item">
            <strong>Solidity</strong>
            <span>Smart Contracts</span>
          </div>
          <div className="stack-item">
            <strong>Sepolia</strong>
            <span>Ethereum Testnet</span>
          </div>
          <div className="stack-item">
            <strong>React + Vite</strong>
            <span>Operator Console</span>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <p>Built for Chainlink CRE Hackathon 2026</p>
      </footer>
    </div>
  )
}
