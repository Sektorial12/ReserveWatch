export default function Tabs({ tabs, activeTab, onTabChange }) {
  const onKeyDown = (e) => {
    const rawIndex = e.currentTarget?.dataset?.index
    const idx = Number(rawIndex)
    if (!Number.isFinite(idx) || !Array.isArray(tabs) || tabs.length === 0) return

    let nextIdx = null
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length
    else if (e.key === "Home") nextIdx = 0
    else if (e.key === "End") nextIdx = tabs.length - 1
    else return

    e.preventDefault()
    const next = tabs[nextIdx]
    if (!next) return
    onTabChange(next.id)

    requestAnimationFrame(() => {
      const el = document.getElementById(`tab-${next.id}`)
      if (el && typeof el.focus === "function") el.focus()
    })
  }

  return (
    <nav className="tabs-nav" role="tablist" aria-label="Console sections">
      {tabs.map((tab, idx) => (
        <button
          key={tab.id}
          id={`tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={`panel-${tab.id}`}
          tabIndex={activeTab === tab.id ? 0 : -1}
          data-index={idx}
          className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
          onClick={() => onTabChange(tab.id)}
          onKeyDown={onKeyDown}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}
