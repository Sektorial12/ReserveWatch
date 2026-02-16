import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import LandingPage from "./components/LandingPage"
import Tabs from "./components/Tabs"
import HeroSection from "./components/HeroSection"
import ProjectsModal from "./components/ProjectsModal"
import OverviewTab from "./components/OverviewTab"
import ConnectorsTab from "./components/ConnectorsTab"
import OnchainTab from "./components/OnchainTab"
import HistoryTab from "./components/HistoryTab"
import SettingsTab from "./components/SettingsTab"

const POLL_MS = 8000

const TABS = [
  { id: "monitor", label: "Live Monitor" },
  { id: "connectors", label: "Connectors" },
  { id: "policy", label: "Policy" },
  { id: "onchain", label: "Onchain" },
  { id: "audit", label: "Audit" },
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

const DRAFT_PROJECTS_KEY = "reservewatch:draftProjects:v1"
const DRAFT_CONNECTORS_KEY = "reservewatch:draftConnectors:v1"
const DRAFT_POLICY_KEY = "reservewatch:draftPolicy:v1"

const readDraftProjects = () => {
  try {
    const raw = window.localStorage.getItem(DRAFT_PROJECTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.id === "string") : []
  } catch {
    return []
  }
}

const writeDraftProjects = (projects) => {
  try {
    window.localStorage.setItem(DRAFT_PROJECTS_KEY, JSON.stringify(projects))
  } catch {
    return
  }
}

const readDraftConnectors = () => {
  try {
    const raw = window.localStorage.getItem(DRAFT_CONNECTORS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((c) => c && typeof c.id === "string" && typeof c.projectId === "string")
      : []
  } catch {
    return []
  }
}

const writeDraftConnectors = (connectors) => {
  try {
    window.localStorage.setItem(DRAFT_CONNECTORS_KEY, JSON.stringify(connectors))
  } catch {
    return
  }
}

const readDraftPolicies = () => {
  try {
    const raw = window.localStorage.getItem(DRAFT_POLICY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((p) => p && typeof p.projectId === "string")
      : []
  } catch {
    return []
  }
}

const writeDraftPolicies = (policies) => {
  try {
    window.localStorage.setItem(DRAFT_POLICY_KEY, JSON.stringify(policies))
  } catch {
    return
  }
}

const normalizeConnectorId = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
}

const uniqueConnectorId = (baseId, used) => {
  const cleanBase = normalizeConnectorId(baseId)
  if (!cleanBase) return ""
  if (!used.has(cleanBase)) return cleanBase

  for (let i = 2; i < 1000; i += 1) {
    const suffix = `-${i}`
    const maxLen = 63 - suffix.length
    const head = cleanBase.slice(0, Math.max(2, maxLen))
    const candidate = `${head}${suffix}`
    if (!used.has(candidate)) return candidate
  }

  return ""
}

export default function App() {
  const [showLanding, setShowLanding] = useState(true)
  const [busy, setBusy] = useState(false)
  const [projects, setProjects] = useState([])
  const [draftProjects, setDraftProjects] = useState(() => readDraftProjects())
  const [draftConnectors, setDraftConnectors] = useState(() => readDraftConnectors())
  const [draftPolicies, setDraftPolicies] = useState(() => readDraftPolicies())
  const [projectsModalOpen, setProjectsModalOpen] = useState(false)
  const [projectId, setProjectId] = useState(null)
  const [status, setStatus] = useState(null)
  const [history, setHistory] = useState([])
  const [error, setError] = useState("")
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null)
  const [incidentMessage, setIncidentMessage] = useState("")
  const [activeTab, setActiveTab] = useState("monitor")

  const pollRef = useRef(null)
  const busyRef = useRef(false)
  const draftProjectsRef = useRef(draftProjects)

  useEffect(() => {
    draftProjectsRef.current = draftProjects
  }, [draftProjects])

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

  const hasAnyProjects = projects.length > 0 || draftProjects.length > 0

  const selectedDraft = useMemo(() => {
    if (!projectId) return null
    return draftProjects.find((p) => p.id === projectId) || null
  }, [draftProjects, projectId])

  const selectedLive = useMemo(() => {
    if (!projectId) return null
    return projects.find((p) => p.id === projectId) || null
  }, [projects, projectId])

  const isLiveProject = useMemo(() => {
    if (!projectId) return false
    return projects.some((p) => p.id === projectId)
  }, [projects, projectId])

  const projectDisplayName = useMemo(() => {
    if (selectedLive?.name) return selectedLive.name
    if (selectedDraft?.name) return selectedDraft.name
    return projectId || ""
  }, [projectId, selectedLive, selectedDraft])

  const rpcHealthy = !status?.onchain?.error
  const rpcBlock = status?.onchain?.blockNumber

  const loadProjects = useCallback(async () => {
    const data = await fetchJson("/api/projects", { timeoutMs: 8000 })
    const allProjects = Array.isArray(data?.projects) ? data.projects : []
    const urlProject = fromUrlProject()

    const draftIds = (draftProjectsRef.current || []).map((p) => p.id)
    const allIds = new Set([...allProjects.map((p) => p.id), ...draftIds].filter(Boolean))
    const defaultId = data?.defaultProjectId || allProjects[0]?.id || draftIds[0] || null
    const selected = urlProject && allIds.has(urlProject) ? urlProject : defaultId

    setProjects(allProjects)
    setProjectId(selected)
    if (selected) writeUrlProject(selected)
  }, [])

  const loadData = useCallback(
    async (overrideProjectId = null) => {
      const activeProjectId = overrideProjectId || projectId
      const live = activeProjectId ? projects.some((p) => p.id === activeProjectId) : false

      if (!activeProjectId || !live) {
        setStatus(null)
        setHistory([])
        setLastUpdatedAt(Date.now())
        setError(
          activeProjectId
            ? `Draft project '${activeProjectId}' is not deployed. Use Projects → Export to deploy it.`
            : "No project selected"
        )
        return
      }

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
    [projectId, projects]
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
  }, [projectId, isLiveProject, withAction])

  useEffect(() => {
    if (!projectId) return

    if (pollRef.current) {
      clearInterval(pollRef.current)
    }

    if (!isLiveProject) {
      pollRef.current = null
      return
    }

    pollRef.current = setInterval(() => {
      void withAction(async () => {}, projectId)
    }, POLL_MS)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [projectId, isLiveProject, withAction])

  const sendMode = useCallback(async (mode) => {
    if (!isLiveProject) throw new Error("Mode control is not available for draft projects")
    await fetchJson("/admin/mode", {
      method: "POST",
      body: { mode },
      timeoutMs: 10000,
    })
  }, [isLiveProject])

  const sendIncident = useCallback(
    async ({ active, severity, message }) => {
      if (!isLiveProject) throw new Error("Incidents are not available for draft projects")
      await fetchJson("/admin/incident", {
        method: "POST",
        body: { projectId, active, severity, message },
        timeoutMs: 10000,
      })
    },
    [projectId, isLiveProject]
  )

  const saveDraftProjects = useCallback((next) => {
    setDraftProjects(next)
    writeDraftProjects(next)

    const keep = new Set((next || []).map((p) => p?.id).filter(Boolean))
    setDraftConnectors((prev) => {
      const arr = Array.isArray(prev) ? prev : []
      const filtered = arr.filter((c) => c && keep.has(c.projectId))
      writeDraftConnectors(filtered)
      return filtered
    })

    setDraftPolicies((prev) => {
      const arr = Array.isArray(prev) ? prev : []
      const filtered = arr.filter((p) => p && keep.has(p.projectId))
      writeDraftPolicies(filtered)
      return filtered
    })
  }, [])

  const saveDraftConnectors = useCallback((next) => {
    setDraftConnectors(next)
    writeDraftConnectors(next)
  }, [])

  const saveDraftPolicies = useCallback((next) => {
    setDraftPolicies(next)
    writeDraftPolicies(next)
  }, [])

  const renameDraftProjectId = useCallback((oldId, newId) => {
    const from = String(oldId || "").trim()
    const to = String(newId || "").trim()
    if (!from || !to || from === to) return

    setDraftConnectors((prev) => {
      const arr = Array.isArray(prev) ? prev : []

      const used = new Set(
        arr
          .filter((c) => c && c.projectId === to)
          .map((c) => normalizeConnectorId(c.id))
          .filter(Boolean)
      )

      const next = arr
        .map((c) => {
          if (!c) return c
          if (c.projectId !== from) return c

          const migratedId = uniqueConnectorId(c.id, used)
          if (!migratedId) return c
          used.add(migratedId)

          return {
            ...c,
            projectId: to,
            id: migratedId,
          }
        })
        .filter(Boolean)

      writeDraftConnectors(next)
      return next
    })

    setDraftPolicies((prev) => {
      const arr = Array.isArray(prev) ? prev : []
      const next = arr.map((p) => {
        if (!p) return p
        if (p.projectId !== from) return p
        return { ...p, projectId: to }
      })
      writeDraftPolicies(next)
      return next
    })
  }, [])

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
          <button className="btn btn-ghost" disabled={busy} onClick={() => setProjectsModalOpen(true)}>
            Projects
          </button>
          <select
            className="project-select"
            value={projectId || ""}
            onChange={(e) => setProjectId(e.target.value || null)}
          >
            {projects.length > 0 && (
              <optgroup label="Live">
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </optgroup>
            )}
            {draftProjects.length > 0 && (
              <optgroup label="Draft">
                {draftProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </optgroup>
            )}
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

      <div className="env-banner">
        <div className="env-banner-left">
          <span className={`env-pill ${!projectId ? "env-none" : isLiveProject ? "env-live" : "env-draft"}`}>
            {!projectId ? "No project" : isLiveProject ? "Live" : "Draft"}
          </span>
          {projectDisplayName && <span className="env-label">{projectDisplayName}</span>}
        </div>
        <div className="env-banner-right">
          {isLiveProject && <span className="env-pill env-mode">Mode: {status?.mode || "--"}</span>}
          {isLiveProject && (
            <span className={`env-pill ${rpcHealthy ? "env-ok" : "env-bad"}`}>
              RPC: {rpcHealthy ? (rpcBlock ? `ok @ ${rpcBlock}` : "ok") : "error"}
            </span>
          )}
          {!isLiveProject && projectId && <span className="env-pill env-warn">Not deployed</span>}
        </div>
      </div>

      {incident?.active && (
        <div className={`incident-alert ${incident.severity === "critical" ? "critical" : "warning"}`}>
          <strong>[{incident.severity?.toUpperCase()}]</strong> {incident.message || "No message"}
        </div>
      )}

      {!hasAnyProjects ? (
        <main className="main-content">
          <div className="first-run-card">
            <h2 className="first-run-title">Create your first project</h2>
            <p className="first-run-subtitle">
              Add an asset, connect data sources, and export a deployment bundle.
            </p>
            <button className="btn btn-primary" onClick={() => setProjectsModalOpen(true)}>
              Open Projects
            </button>
          </div>
        </main>
      ) : (
        <>
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
            {activeTab === "monitor" && (
              <OverviewTab
                derived={derived}
                receiver={receiver}
                token={token}
                mode={status?.mode}
              />
            )}

            {activeTab === "connectors" && (
              <ConnectorsTab
                projectId={projectId}
                isLiveProject={isLiveProject}
                draftConnectors={draftConnectors}
                onSaveDraftConnectors={saveDraftConnectors}
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

            {activeTab === "policy" && (
              <SettingsTab
                projectId={projectId}
                isLiveProject={isLiveProject}
                derived={derived}
                interfaces={status?.interfaces}
                operator={status?.operator}
                status={status}
                draftProject={selectedDraft}
                draftPolicies={draftPolicies}
                onSaveDraftPolicies={saveDraftPolicies}
                mode={status?.mode}
                onSetMode={(mode) => void withAction(async () => sendMode(mode))}
                busy={busy}
              />
            )}

            {activeTab === "onchain" && <OnchainTab onchain={status?.onchain} links={status?.links} />}

            {activeTab === "audit" && <HistoryTab history={history} />}
          </main>
        </>
      )}

      <ProjectsModal
        open={projectsModalOpen}
        onClose={() => setProjectsModalOpen(false)}
        serverProjects={projects}
        draftProjects={draftProjects}
        draftPolicies={draftPolicies}
        onSaveDraftProjects={saveDraftProjects}
        onRenameDraftProjectId={renameDraftProjectId}
        activeProjectId={projectId}
        onSelectProjectId={(id) => setProjectId(id || null)}
      />

      <footer className="footer">
        <span>ReserveWatch Console</span>
        <span>Chainlink CRE Hackathon 2026</span>
      </footer>
    </div>
  )
}
