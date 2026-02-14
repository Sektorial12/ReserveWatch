import { useState } from "react"

export default function Tabs({ tabs, activeTab, onTabChange }) {
  return (
    <nav className="tabs-nav">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}
