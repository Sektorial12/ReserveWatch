import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import LandingPage from "./components/LandingPage"
import Tabs from "./components/Tabs"
import HeroSection from "./components/HeroSection"
import OverviewTab from "./components/OverviewTab"
import SourcesTab from "./components/SourcesTab"
import OnchainTab from "./components/OnchainTab"
import HistoryTab from "./components/HistoryTab"
import SettingsTab from "./components/SettingsTab"

const POLL_MS = 8000

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "sources", label: "Sources" },
  { id: "onchain", label: "Onchain" },
  { id: "history", label: "History" },
  { id: "settings", label: "Settings" },
]

const fetchJson = async (url, init = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs || 12000)

  try {
    const response = await fetch(url, {
      method: init.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(init.headers || {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`HTTP ${response.status}${text ? ` ${text}` : ""}`)
    }

    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}

const fromUrlProject = () => {
  const u = new URL(window.location.href)
  return u.searchParams.get("project")
}

const writeUrlProject = (projectId) => {
  const u = new URL(window.location.href)
  if (projectId) u.searchParams.set("project", projectId)
  else u.searchParams.delete("project")
  window.history.replaceState({}, "", u.toString())
}

const formatInt = (value) => {
  if (value === null || value === undefined) return "--"
  const n = Number(value)
  if (!Number.isFinite(n)) return "--"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n)
}

export default function App() {
  const [showLanding, setShowLanding] = useState(true)
  const [busy, setBusy] = useState(false)
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState(null)
  const [status, setStatus] = useState(null)
  const [history, setHistory] = useState([])
  const [error, setError] = useState("")
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null)
  const [incidentMessage, setIncidentMessage] = useState("")
  const [activeTab, setActiveTab] = useState("overview")

  const pollRef = useRef(null)
  const busyRef = useRef(false)

  const derived = status?.derived || {}
  const receiver = status?.onchain?.receiver || {}
  const token = status?.onchain?.token || {}
  const incident = status?.incident || null

  const statusValue = typeof derived.status === "string" ? derived.status : "STALE"

  const statusLine = useMemo(() => {
    if (error) return error
    if (status?.onchain?.error) return `Onchain error: ${status.onchain.error}`
    return `Coverage ${formatInt(receiver.lastCoverageBps)} bps / min ${formatInt(receiver.minCoverageBps)} bps`
  }, [error, status, receiver])

  const reserveRows = useMemo(() => {
    const rows = [status?.reserves?.primary, status?.reserves?.secondary].filter(Boolean)
    const ages = derived?.reserveAgesS || {}
    return rows.map((row, idx) => ({
      ...row,
      age: idx === 0 ? ages.primary : ages.secondary,
    }))
  }, [status, derived])

  const loadProjects = useCallback(async () => {
    const data = await fetchJson("/api/projects", { timeoutMs: 8000 })
    const allProjects = Array.isArray(data?.projects) ? data.projects : []
    const defaultId = data?.defaultProjectId || allProjects[0]?.id || null
    const urlProject = fromUrlProject()
    const selected = urlProject || defaultId

    setProjects(allProjects)
    setProjectId(selected)
    if (selected) writeUrlProject(selected)
  }, [])

  const loadData = useCallback(
    async (overrideProjectId = null) => {
      const activeProjectId = overrideProjectId || projectId
      const query = activeProjectId ? `?project=${encodeURIComponent(activeProjectId)}` : ""

      const [statusRes, historyRes] = await Promise.all([
        fetchJson(`/api/status${query}`, { timeoutMs: 12000 }),
        fetchJson(`/api/history${query ? `${query}&limit=10` : "?limit=10"}`, { timeoutMs: 12000 }),
      ])

      setStatus(statusRes)
      setHistory(Array.isArray(historyRes?.events) ? historyRes.events : [])
      setLastUpdatedAt(Date.now())
      setError("")
    },
    [projectId]
  )

  const withAction = useCallback(
    async (fn, overrideProjectId = null) => {
      if (busyRef.current) return

      busyRef.current = true
      setBusy(true)

      try {
        await fn()
        await loadData(overrideProjectId)
      } catch (err) {
        setError(String(err?.message || err))
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [loadData]
  )

  useEffect(() => {
    void (async () => {
      setBusy(true)
      try {
        await loadProjects()
      } catch (err) {
        setError(String(err?.message || err))
      } finally {
        setBusy(false)
      }
    })()
  }, [loadProjects])

  useEffect(() => {
    if (!projectId) return

    void withAction(async () => {
      writeUrlProject(projectId)
    }, projectId)
  }, [projectId, withAction])

  useEffect(() => {
    if (!projectId) return

    if (pollRef.current) {
      clearInterval(pollRef.current)
    }

    pollRef.current = setInterval(() => {
      void withAction(async () => {}, projectId)
    }, POLL_MS)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [projectId, withAction])

  const sendMode = useCallback(async (mode) => {
    await fetchJson("/admin/mode", {
      method: "POST",
      body: { mode },
      timeoutMs: 10000,
    })
  }, [])

  const sendIncident = useCallback(
    async ({ active, severity, message }) => {
      await fetchJson("/admin/incident", {
        method: "POST",
        body: { projectId, active, severity, message },
        timeoutMs: 10000,
      })
    },
    [projectId]
  )

  const reasons = Array.isArray(derived.reasons) ? derived.reasons : []

  if (showLanding) {
    return <LandingPage onEnterDashboard={() => setShowLanding(false)} />
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <button className="back-btn" onClick={() => setShowLanding(true)} title="Back to landing">
            ←
          </button>
          <div>
            <span className="header-eyebrow">Chainlink CRE</span>
            <h1 className="header-title">ReserveWatch</h1>
          </div>
        </div>
        <div className="header-actions">
          <select
            className="project-select"
            value={projectId || ""}
            onChange={(e) => setProjectId(e.target.value || null)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void withAction(async () => {})}
          >
            {busy ? "Syncing..." : "Refresh"}
          </button>
        </div>
      </header>

      {incident?.active && (
        <div className={`incident-alert ${incident.severity === "critical" ? "critical" : "warning"}`}>
          <strong>[{incident.severity?.toUpperCase()}]</strong> {incident.message || "No message"}
        </div>
      )}

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

      <Tabs tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      <main className="main-content">
        {activeTab === "overview" && (
          <OverviewTab
            derived={derived}
            receiver={receiver}
            token={token}
            mode={status?.mode}
          />
        )}

        {activeTab === "sources" && (
          <SourcesTab
            reserveRows={reserveRows}
            incident={incident}
            incidentMessage={incidentMessage}
            setIncidentMessage={setIncidentMessage}
            onSetIncident={(severity) =>
              void withAction(async () =>
                sendIncident({
                  active: true,
                  severity,
                  message: incidentMessage || `${severity} incident`,
                })
              )
            }
            onClearIncident={() =>
              void withAction(async () =>
                sendIncident({ active: false, severity: "warning", message: "" })
              )
            }
            busy={busy}
          />
        )}

        {activeTab === "onchain" && (
          <OnchainTab onchain={status?.onchain} links={status?.links} />
        )}

        {activeTab === "history" && <HistoryTab history={history} />}

        {activeTab === "settings" && (
          <SettingsTab
            derived={derived}
            interfaces={status?.interfaces}
            operator={status?.operator}
            mode={status?.mode}
            onSetMode={(mode) => void withAction(async () => sendMode(mode))}
            busy={busy}
          />
        )}
      </main>

      <footer className="footer">
        <span>ReserveWatch Console</span>
        <span>Chainlink CRE Hackathon 2026</span>
      </footer>
    </div>
  )
}
