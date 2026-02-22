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
import PublicStatusPage from "./components/PublicStatusPage"
import ReportTab from "./components/ReportTab"
import StatusPill from "./components/StatusPill"
import OnboardingWizardModal from "./components/OnboardingWizardModal"
import AlertsTab from "./components/AlertsTab"
import useClientMonitor from "./hooks/useClientMonitor"

const POLL_MS = 8000
const HISTORY_SWR_MS = 60000

const TABS = [
  { id: "monitor", label: "Live Monitor" },
  { id: "connectors", label: "Connectors" },
  { id: "alerts", label: "Alerts" },
  { id: "policy", label: "Policy" },
  { id: "onchain", label: "Onchain" },
  { id: "report", label: "Report" },
  { id: "audit", label: "Audit" },
]

const ADMIN_KEY = String(import.meta.env?.VITE_RESERVEWATCH_ADMIN_KEY || "").trim()

const fetchJson = async (url, init = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs || 12000)

  try {
    const method = String(init.method || "GET").toUpperCase()
    const headers = {
      "content-type": "application/json",
      ...(init.headers || {}),
    }

    if ((method === "POST" || method === "PUT" || method === "DELETE") && ADMIN_KEY) {
      const hasAuth = Object.keys(headers).some((key) => {
        const k = String(key || "").toLowerCase()
        return k === "x-admin-key" || k === "authorization"
      })
      if (!hasAuth) headers["x-admin-key"] = ADMIN_KEY
    }

    const response = await fetch(url, {
      method,
      headers,
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

const fromUrlDraft = () => {
  const u = new URL(window.location.href)
  const raw = u.searchParams.get("draft")
  const s = String(raw || "").trim().toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

const writeUrlProject = (projectId, { draft = false } = {}) => {
  const u = new URL(window.location.href)
  if (projectId) u.searchParams.set("project", projectId)
  else u.searchParams.delete("project")
  if (draft) u.searchParams.set("draft", "1")
  else u.searchParams.delete("draft")
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

const ALERT_ROUTING_KEY = "reservewatch:alertRouting:v1"
const ALERT_RULES_KEY = "reservewatch:alertRules:v1"
const ALERT_INCIDENTS_KEY = "reservewatch:alertIncidents:v1"

const DEFAULT_ALERT_ROUTING = {
  enableOutbound: false,
  slackWebhookUrl: "",
  discordWebhookUrl: "",
}

const DEFAULT_ALERT_RULES = {
  coverageBreach: true,
  sourceStale: true,
  sourceMismatch: true,
  rpcFailures: true,
}

const INCIDENT_COOLDOWN_MS = 30000
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000
const SNOOZE_MS = 15 * 60 * 1000

const normalizeIncidentId = ({ projectId, reason }) => {
  const pid = String(projectId || "").trim() || "unknown"
  const r = String(reason || "").trim() || "unknown"
  return `${pid}:${r}`
}

const reasonToSeverity = (reason) => {
  if (reason === "coverage_below_threshold") return "critical"
  return "warning"
}

const rulesAllowReason = (reason, rules) => {
  const r = String(reason || "")
  const cfg = rules || DEFAULT_ALERT_RULES
  if (r === "coverage_below_threshold") return Boolean(cfg.coverageBreach)
  if (r === "reserve_data_stale" || r === "reserve_signature_invalid") return Boolean(cfg.sourceStale)
  if (r === "reserve_source_mismatch") return Boolean(cfg.sourceMismatch)
  if (r === "onchain_unavailable") return Boolean(cfg.rpcFailures)
  return false
}

const postWebhook = async ({ url, body }) => {
  const cleanUrl = String(url || "").trim()
  if (!cleanUrl) return
  await fetch(cleanUrl, {
    method: "POST",
    mode: "no-cors",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body || {}),
  })
}

const dispatchOutbound = async ({ routing, incident, statusValue }) => {
  const cfg = routing || DEFAULT_ALERT_ROUTING
  if (!cfg.enableOutbound) return

  const pid = incident?.projectId || "--"
  const reason = incident?.reason || "--"
  const sev = incident?.severity || "warning"
  const msg = `[ReserveWatch] ${pid} ${sev.toUpperCase()} ${reason} (status=${statusValue || "--"})`

  const slack = String(cfg.slackWebhookUrl || "").trim()
  const discord = String(cfg.discordWebhookUrl || "").trim()

  try {
    if (slack) {
      await postWebhook({ url: slack, body: { text: msg } })
    }
  } catch {
    return
  }

  try {
    if (discord) {
      await postWebhook({ url: discord, body: { content: msg } })
    }
  } catch {
    return
  }
}

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

const parseStatusPath = () => {
  const raw = String(window.location.pathname || "/")
  const path = raw.replace(/\/+$/, "")
  if (!path) return null

  const parts = path.split("/").filter(Boolean)
  if (parts.length === 2 && parts[1] === "status") {
    return parts[0]
  }
  if (parts.length === 3 && parts[0] === "console" && parts[2] === "status") {
    return parts[1]
  }
  return null
}

export default function App() {
  const [showLanding, setShowLanding] = useState(true)
  const [busy, setBusy] = useState(false)
  const [polling, setPolling] = useState(false)
  const [projects, setProjects] = useState([])
  const [draftProjects, setDraftProjects] = useState([])
  const [draftConnectors, setDraftConnectors] = useState([])
  const [draftPolicies, setDraftPolicies] = useState([])
  const [alertRouting, setAlertRouting] = useState(() => {
    try {
      const raw = window.localStorage.getItem(ALERT_ROUTING_KEY)
      if (!raw) return DEFAULT_ALERT_ROUTING
      const parsed = JSON.parse(raw)
      return { ...DEFAULT_ALERT_ROUTING, ...(parsed || {}) }
    } catch {
      return DEFAULT_ALERT_ROUTING
    }
  })
  const [alertRules, setAlertRules] = useState(() => {
    try {
      const raw = window.localStorage.getItem(ALERT_RULES_KEY)
      if (!raw) return DEFAULT_ALERT_RULES
      const parsed = JSON.parse(raw)
      return { ...DEFAULT_ALERT_RULES, ...(parsed || {}) }
    } catch {
      return DEFAULT_ALERT_RULES
    }
  })
  const [alertIncidents, setAlertIncidents] = useState(() => {
    try {
      const raw = window.localStorage.getItem(ALERT_INCIDENTS_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter(Boolean) : []
    } catch {
      return []
    }
  })
  const [projectsModalOpen, setProjectsModalOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [projectId, setProjectId] = useState(null)
  const [activeEnv, setActiveEnv] = useState("live")
  const [liveStatus, setLiveStatus] = useState(null)
  const [history, setHistory] = useState([])
  const [historyMeta, setHistoryMeta] = useState(null)
  const [liveError, setLiveError] = useState("")
  const [liveLastUpdatedAt, setLiveLastUpdatedAt] = useState(null)
  const [incidentMessage, setIncidentMessage] = useState("")
  const [activeTab, setActiveTab] = useState("monitor")

  const statusPathProjectId = useMemo(() => parseStatusPath(), [])
  const isPublicStatusPage = Boolean(statusPathProjectId)
  const [publicStatus, setPublicStatus] = useState(null)
  const [publicBusy, setPublicBusy] = useState(false)
  const [publicError, setPublicError] = useState("")
  const [publicLastUpdatedAt, setPublicLastUpdatedAt] = useState(null)
  const [publicNotFound, setPublicNotFound] = useState(false)

  const pollRef = useRef(null)
  const busyRef = useRef(false)
  const pendingActionRef = useRef(null)
  const projectsRef = useRef(projects)
  const draftProjectsRef = useRef(draftProjects)
  const draftConnectorsRef = useRef(draftConnectors)
  const draftPoliciesRef = useRef(draftPolicies)
  const pendingProjectRenamesRef = useRef([])
  const statusCacheRef = useRef(new Map())
  const historyCacheRef = useRef(new Map())
  const historyFetchedAtRef = useRef(new Map())

  useEffect(() => {
    projectsRef.current = projects
  }, [projects])

  useEffect(() => {
    draftProjectsRef.current = draftProjects
  }, [draftProjects])

  useEffect(() => {
    draftConnectorsRef.current = draftConnectors
  }, [draftConnectors])

  useEffect(() => {
    draftPoliciesRef.current = draftPolicies
  }, [draftPolicies])

  const selectedDraft = useMemo(() => {
    if (!projectId) return null
    return draftProjects.find((p) => p.id === projectId) || null
  }, [draftProjects, projectId])

  const selectedLive = useMemo(() => {
    if (!projectId) return null
    return projects.find((p) => p.id === projectId) || null
  }, [projects, projectId])

  const hasLiveConfig = useMemo(() => {
    if (!projectId) return false
    return projects.some((p) => p.id === projectId)
  }, [projects, projectId])

  const isLiveProject = useMemo(() => {
    if (!projectId) return false
    return activeEnv === "live" && hasLiveConfig
  }, [activeEnv, hasLiveConfig, projectId])

  const draftOnlyProjects = useMemo(() => {
    const liveIds = new Set((projects || []).map((p) => p?.id).filter(Boolean))
    return (draftProjects || []).filter((p) => p && !liveIds.has(p.id))
  }, [projects, draftProjects])

  const draftConnectorsForProject = useMemo(() => {
    if (!projectId) return []
    return (draftConnectors || []).filter((c) => c && c.projectId === projectId)
  }, [draftConnectors, projectId])

  const draftPolicyForProject = useMemo(() => {
    if (!projectId) return null
    return (draftPolicies || []).find((p) => p && p.projectId === projectId) || null
  }, [draftPolicies, projectId])

  const clientMonitorEnabled = Boolean(projectId && !isLiveProject && selectedDraft)
  const {
    status: clientStatus,
    error: clientError,
    busy: clientBusy,
    lastUpdatedAt: clientLastUpdatedAt,
    refresh: refreshClientStatus,
  } = useClientMonitor({
    enabled: clientMonitorEnabled,
    project: selectedDraft,
    connectors: draftConnectorsForProject,
    policy: draftPolicyForProject,
    pollMs: POLL_MS,
  })

  const status = isLiveProject ? liveStatus : clientStatus
  const error = isLiveProject ? liveError : clientError
  const lastUpdatedAt = isLiveProject ? liveLastUpdatedAt : clientLastUpdatedAt

  const derived = status?.derived || {}
  const receiver = status?.onchain?.receiver || {}
  const token = status?.onchain?.token || {}
  const incident = status?.incident || null
  const effectiveBusy = busy || polling || (!isLiveProject && clientBusy)

  const reasons = Array.isArray(derived.reasons) ? derived.reasons : []

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

  const projectDisplayName = useMemo(() => {
    if (selectedLive?.name) return selectedLive.name
    if (selectedDraft?.name) return selectedDraft.name
    return projectId || ""
  }, [projectId, selectedLive, selectedDraft])

  const rpcHealthy = !status?.onchain?.error
  const rpcBlock = status?.onchain?.blockNumber

  const loadProjects = useCallback(async () => {
    const urlProject = fromUrlProject()
    const urlDraft = fromUrlDraft()
    const draftUrl = (p) => `${p}${p.includes("?") ? "&" : "?"}draft=1`

    const [liveProjectsRes, draftProjectsRes, draftConnectorsRes, draftPoliciesRes] = await Promise.allSettled([
      fetchJson("/api/projects", { timeoutMs: 8000 }),
      fetchJson(draftUrl("/api/projects"), { timeoutMs: 8000 }),
      fetchJson(draftUrl("/api/connectors"), { timeoutMs: 8000 }),
      fetchJson(draftUrl("/api/policies"), { timeoutMs: 8000 }),
    ])

    const liveProjects =
      liveProjectsRes.status === "fulfilled" && Array.isArray(liveProjectsRes.value?.projects) ? liveProjectsRes.value.projects : []
    const liveDefaultProjectId = liveProjectsRes.status === "fulfilled" ? liveProjectsRes.value?.defaultProjectId || null : null

    const drafts =
      draftProjectsRes.status === "fulfilled" && Array.isArray(draftProjectsRes.value?.projects) ? draftProjectsRes.value.projects : []
    const draftDefaultProjectId = draftProjectsRes.status === "fulfilled" ? draftProjectsRes.value?.defaultProjectId || null : null

    const draftConnectors =
      draftConnectorsRes.status === "fulfilled" && Array.isArray(draftConnectorsRes.value?.connectors)
        ? draftConnectorsRes.value.connectors
        : []
    const draftPolicies =
      draftPoliciesRes.status === "fulfilled" && Array.isArray(draftPoliciesRes.value?.policies) ? draftPoliciesRes.value.policies : []

    const allIds = new Set([...liveProjects.map((p) => p?.id), ...drafts.map((p) => p?.id)].filter(Boolean))
    const defaultId = liveDefaultProjectId || liveProjects[0]?.id || draftDefaultProjectId || drafts[0]?.id || null
    const selected = urlProject && allIds.has(urlProject) ? urlProject : defaultId

    const selectedHasLive = selected ? liveProjects.some((p) => p && p.id === selected) : false
    const nextEnv = urlDraft || (!selectedHasLive && selected) ? "draft" : "live"

    projectsRef.current = liveProjects
    setProjects(liveProjects)
    setDraftProjects(drafts)
    setDraftConnectors(draftConnectors)
    setDraftPolicies(draftPolicies)
    setProjectId(selected)
    setActiveEnv(nextEnv)
    if (selected) writeUrlProject(selected, { draft: nextEnv === "draft" })
    setLiveError("")
  }, [])

  const loadPublicStatus = useCallback(async () => {
    const pid = String(statusPathProjectId || "").trim()
    if (!pid) return

    setPublicBusy(true)
    try {
      const [statusRes, projectsRes] = await Promise.all([
        fetchJson(`/api/status?project=${encodeURIComponent(pid)}`, { timeoutMs: 12000 }),
        fetchJson("/api/projects", { timeoutMs: 8000 }).catch(() => null),
      ])
      const list = Array.isArray(projectsRes?.projects) ? projectsRes.projects : []
      setPublicNotFound(list.length ? !list.some((p) => p && p.id === pid) : false)
      setPublicStatus(statusRes)
      setPublicLastUpdatedAt(Date.now())
      setPublicError("")
    } catch (err) {
      setPublicError(String(err?.message || err))
      setPublicLastUpdatedAt(Date.now())
    } finally {
      setPublicBusy(false)
    }
  }, [statusPathProjectId])

  const loadData = useCallback(
    async (overrideProjectId = null, options = {}) => {
      const activeProjectId = overrideProjectId || projectId
      const live =
        activeEnv === "live" && activeProjectId ? (projectsRef.current || []).some((p) => p && p.id === activeProjectId) : false

      if (!activeProjectId || !live) {
        setLiveStatus(null)
        setHistory([])
        setHistoryMeta(null)
        setLiveLastUpdatedAt(Date.now())
        setLiveError("")
        return
      }

      const query = activeProjectId ? `?project=${encodeURIComponent(activeProjectId)}` : ""

      const cachedStatus = statusCacheRef.current.get(activeProjectId)
      if (cachedStatus?.data) {
        setLiveStatus(cachedStatus.data)
      } else {
        setLiveStatus(null)
      }

      const cachedHistory = historyCacheRef.current.get(activeProjectId)
      if (cachedHistory?.events) {
        setHistory(cachedHistory.events)
        setHistoryMeta(cachedHistory.meta || null)
      } else {
        setHistory([])
        setHistoryMeta(null)
      }

      const wantsHistory = activeTab === "audit" || activeTab === "report"
      const forceHistory = Boolean(options?.forceHistory)
      const lastHistoryFetch = historyFetchedAtRef.current.get(activeProjectId) || 0
      const shouldFetchHistory =
        forceHistory || (wantsHistory && (Date.now() - lastHistoryFetch > HISTORY_SWR_MS || !cachedHistory))

      const requests = [
        fetchJson(`/api/status${query}`, { timeoutMs: 12000 }),
        shouldFetchHistory
          ? fetchJson(`/api/history${query ? `${query}&limit=50` : "?limit=50"}`, { timeoutMs: 12000 })
          : Promise.resolve(null),
      ]

      const [statusResult, historyResult] = await Promise.allSettled(requests)

      if (statusResult.status === "fulfilled") {
        setLiveStatus(statusResult.value)
        statusCacheRef.current.set(activeProjectId, { data: statusResult.value, fetchedAt: Date.now() })
        setLiveLastUpdatedAt(Date.now())
        setLiveError("")
      } else {
        setLiveError(String(statusResult.reason?.message || statusResult.reason || "Status fetch failed"))
        setLiveLastUpdatedAt(Date.now())
      }

      if (!shouldFetchHistory) {
        return
      }

      if (historyResult.status === "fulfilled") {
        const historyRes = historyResult.value
        const events = Array.isArray(historyRes?.events) ? historyRes.events : []
        const meta = historyRes
          ? {
              project: historyRes?.project || null,
              receiverAddress: historyRes?.receiverAddress || null,
              rpcUrl: historyRes?.rpcUrl || null,
              fromBlock: historyRes?.fromBlock || null,
              toBlock: historyRes?.toBlock || null,
              error: historyRes?.error || null,
            }
          : null

        setHistory(events)
        setHistoryMeta(meta)
        historyCacheRef.current.set(activeProjectId, { events, meta })
        historyFetchedAtRef.current.set(activeProjectId, Date.now())
      } else {
        const msg = String(historyResult.reason?.message || historyResult.reason || "History fetch failed")
        setHistoryMeta((prev) => {
          if (prev) return { ...prev, error: msg }
          return { project: activeProjectId, receiverAddress: null, rpcUrl: null, fromBlock: null, toBlock: null, error: msg }
        })
        historyFetchedAtRef.current.set(activeProjectId, Date.now())
      }
    },
    [projectId, activeTab, activeEnv]
  )

  const withAction = useCallback(
    async (fn, overrideProjectId = null, loadOptions = null) => {
      if (busyRef.current) {
        pendingActionRef.current = { fn, overrideProjectId, loadOptions }
        return
      }

      busyRef.current = true
      const silent = Boolean(loadOptions?.silent)
      if (!silent) setBusy(true)
      else setPolling(true)

      try {
        await fn()
        await loadData(overrideProjectId, loadOptions)
      } catch (err) {
        setLiveError(String(err?.message || err))
      } finally {
        busyRef.current = false
        if (!silent) setBusy(false)
        else setPolling(false)

        const pending = pendingActionRef.current
        if (pending) {
          pendingActionRef.current = null
          void withAction(pending.fn, pending.overrideProjectId, pending.loadOptions)
        }
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
        setLiveError(String(err?.message || err))
      } finally {
        setBusy(false)
      }
    })()
  }, [loadProjects])

  useEffect(() => {
    if (!isPublicStatusPage) return
    void loadPublicStatus()
    const t = setInterval(() => {
      void loadPublicStatus()
    }, POLL_MS)
    return () => clearInterval(t)
  }, [isPublicStatusPage, loadPublicStatus])

  useEffect(() => {
    if (!projectId) return

    writeUrlProject(projectId, { draft: !isLiveProject })

    if (!isLiveProject) return
    void withAction(async () => {}, projectId)
  }, [projectId, isLiveProject, withAction])

  useEffect(() => {
    if (!projectId || !isLiveProject) return
    if (activeTab !== "audit" && activeTab !== "report") return
    void withAction(async () => {}, projectId, { forceHistory: true })
  }, [activeTab, projectId, isLiveProject, withAction])

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
      void withAction(async () => {}, projectId, { silent: true })
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

  const saveDraftProjects = useCallback(
    (next) => {
      const nextArr = Array.isArray(next) ? next.filter(Boolean) : []
      const prevSnapshot = Array.isArray(draftProjectsRef.current) ? draftProjectsRef.current.filter(Boolean) : []
      setDraftProjects(nextArr)

      const keep = new Set(nextArr.map((p) => p?.id).filter(Boolean))
      setDraftConnectors((prev) => {
        const arr = Array.isArray(prev) ? prev : []
        return arr.filter((c) => c && keep.has(c.projectId))
      })
      setDraftPolicies((prev) => {
        const arr = Array.isArray(prev) ? prev : []
        return arr.filter((p) => p && keep.has(p.projectId))
      })

      void withAction(async () => {
        const cleanId = (value) => String(value || "").trim()
        const prevArr = prevSnapshot
        const prevById = new Map(prevArr.map((p) => [cleanId(p?.id), p]).filter(([id]) => id))
        const nextById = new Map(nextArr.map((p) => [cleanId(p?.id), p]).filter(([id]) => id))

        const deletedIds = new Set(Array.from(prevById.keys()).filter((id) => !nextById.has(id)))
        const addedIds = new Set(Array.from(nextById.keys()).filter((id) => !prevById.has(id)))

        const renames = Array.isArray(pendingProjectRenamesRef.current) ? pendingProjectRenamesRef.current : []
        pendingProjectRenamesRef.current = []

        for (const r of renames) {
          const from = cleanId(r?.from)
          const to = cleanId(r?.to)
          const payload = to ? nextById.get(to) : null
          if (!from || !to || !payload) continue
          await fetchJson("/api/projects?draft=1", {
            method: "PUT",
            body: { ...payload, previousId: from },
            timeoutMs: 12000,
          })
          deletedIds.delete(from)
          addedIds.delete(to)
          prevById.delete(from)
          prevById.set(to, payload)
        }

        for (const [id, payload] of nextById.entries()) {
          if (!prevById.has(id)) continue
          const before = prevById.get(id)
          if (JSON.stringify(before) === JSON.stringify(payload)) continue
          await fetchJson("/api/projects?draft=1", { method: "PUT", body: payload, timeoutMs: 12000 })
        }

        for (const id of addedIds) {
          const payload = nextById.get(id)
          if (!payload) continue
          await fetchJson("/api/projects?draft=1", { method: "POST", body: payload, timeoutMs: 12000 })
        }

        for (const id of deletedIds) {
          await fetchJson("/api/projects?draft=1", { method: "DELETE", body: { id }, timeoutMs: 12000 })
        }

        await loadProjects()
      })
    },
    [withAction, loadProjects]
  )

  const saveDraftConnectors = useCallback(
    (next) => {
      const nextArr = Array.isArray(next) ? next.filter(Boolean) : []
      const prevSnapshot = Array.isArray(draftConnectorsRef.current) ? draftConnectorsRef.current.filter(Boolean) : []
      setDraftConnectors(nextArr)

      const toKey = (c) => {
        if (!c) return ""
        const pid = String(c.projectId || "").trim()
        const id = normalizeConnectorId(c.id)
        if (!pid || !id) return ""
        return `${pid}:${id}`
      }

      void withAction(async () => {
        const prevArr = prevSnapshot
        const prevByKey = new Map(prevArr.map((c) => [toKey(c), c]).filter(([k]) => k))
        const nextByKey = new Map(nextArr.map((c) => [toKey(c), c]).filter(([k]) => k))

        const deleted = Array.from(prevByKey.keys()).filter((k) => !nextByKey.has(k))
        const added = Array.from(nextByKey.keys()).filter((k) => !prevByKey.has(k))

        for (const k of deleted) {
          const c = prevByKey.get(k)
          if (!c) continue
          await fetchJson("/api/connectors?draft=1", {
            method: "DELETE",
            body: { projectId: c.projectId, id: normalizeConnectorId(c.id) },
            timeoutMs: 12000,
          })
        }

        for (const [k, payload] of nextByKey.entries()) {
          if (!prevByKey.has(k)) continue
          const before = prevByKey.get(k)
          if (JSON.stringify(before) === JSON.stringify(payload)) continue
          await fetchJson("/api/connectors?draft=1", { method: "PUT", body: payload, timeoutMs: 12000 })
        }

        for (const k of added) {
          const payload = nextByKey.get(k)
          if (!payload) continue
          await fetchJson("/api/connectors?draft=1", { method: "POST", body: payload, timeoutMs: 12000 })
        }

        await loadProjects()
      })
    },
    [withAction, loadProjects]
  )

  const saveDraftPolicies = useCallback(
    (next) => {
      const nextArr = Array.isArray(next) ? next.filter(Boolean) : []
      const prevSnapshot = Array.isArray(draftPoliciesRef.current) ? draftPoliciesRef.current.filter(Boolean) : []
      setDraftPolicies(nextArr)

      const toKey = (p) => String(p?.projectId || "").trim()

      void withAction(async () => {
        const prevArr = prevSnapshot
        const prevByKey = new Map(prevArr.map((p) => [toKey(p), p]).filter(([k]) => k))
        const nextByKey = new Map(nextArr.map((p) => [toKey(p), p]).filter(([k]) => k))

        const deleted = Array.from(prevByKey.keys()).filter((k) => !nextByKey.has(k))
        const added = Array.from(nextByKey.keys()).filter((k) => !prevByKey.has(k))

        for (const k of deleted) {
          await fetchJson("/api/policies?draft=1", { method: "DELETE", body: { projectId: k }, timeoutMs: 12000 })
        }

        for (const [k, payload] of nextByKey.entries()) {
          if (!prevByKey.has(k)) continue
          const before = prevByKey.get(k)
          if (JSON.stringify(before) === JSON.stringify(payload)) continue
          await fetchJson("/api/policies?draft=1", { method: "PUT", body: payload, timeoutMs: 12000 })
        }

        for (const k of added) {
          const payload = nextByKey.get(k)
          if (!payload) continue
          await fetchJson("/api/policies?draft=1", { method: "POST", body: payload, timeoutMs: 12000 })
        }

        await loadProjects()
      })
    },
    [withAction, loadProjects]
  )

  const saveAlertRouting = useCallback((next) => {
    setAlertRouting(next)
    try {
      window.localStorage.setItem(ALERT_ROUTING_KEY, JSON.stringify(next))
    } catch {
      return
    }
  }, [])

  const saveAlertRules = useCallback((next) => {
    setAlertRules(next)
    try {
      window.localStorage.setItem(ALERT_RULES_KEY, JSON.stringify(next))
    } catch {
      return
    }
  }, [])

  const writeAlertIncidents = useCallback((next) => {
    try {
      window.localStorage.setItem(ALERT_INCIDENTS_KEY, JSON.stringify(next))
    } catch {
      return
    }
  }, [])

  const updateIncident = useCallback(
    (id, updater) => {
      setAlertIncidents((prev) => {
        const arr = Array.isArray(prev) ? prev : []
        const next = arr.map((inc) => {
          if (!inc || inc.id !== id) return inc
          return updater(inc)
        })
        writeAlertIncidents(next)
        return next
      })
    },
    [writeAlertIncidents]
  )

  const acknowledgeIncident = useCallback(
    (id) => updateIncident(id, (inc) => ({ ...inc, state: "ack", updatedAt: Date.now() })),
    [updateIncident]
  )

  const snoozeIncident = useCallback(
    (id) =>
      updateIncident(id, (inc) => ({ ...inc, state: "snoozed", snoozedUntil: Date.now() + SNOOZE_MS, updatedAt: Date.now() })),
    [updateIncident]
  )

  const resolveIncident = useCallback(
    (id) => updateIncident(id, (inc) => ({ ...inc, state: "resolved", updatedAt: Date.now() })),
    [updateIncident]
  )

  const reopenIncident = useCallback(
    (id) => updateIncident(id, (inc) => ({ ...inc, state: "open", snoozedUntil: null, updatedAt: Date.now() })),
    [updateIncident]
  )

  const clearResolvedIncidents = useCallback(() => {
    setAlertIncidents((prev) => {
      const arr = Array.isArray(prev) ? prev : []
      const next = arr.filter((inc) => inc && inc.state !== "resolved")
      writeAlertIncidents(next)
      return next
    })
  }, [writeAlertIncidents])

  const publishDrafts = useCallback(() => {
    if (!projectId) return
    void withAction(async () => {
      await fetchJson("/api/publish", { method: "POST", timeoutMs: 12000 })
      await loadProjects()
    }, projectId)
  }, [withAction, loadProjects, projectId])

  useEffect(() => {
    if (!projectId) return
    if (!status) return

    const now = Date.now()
    const firing = new Set(reasons.filter((r) => rulesAllowReason(r, alertRules)))
    const outbound = []

    setAlertIncidents((prev) => {
      const arr = Array.isArray(prev) ? prev.filter(Boolean) : []
      const byId = new Map(arr.map((inc) => [inc.id, inc]))

      for (const reason of firing) {
        const id = normalizeIncidentId({ projectId, reason })
        const existing = byId.get(id)
        const existingState = existing?.state || "open"
        const snoozedUntil = existing?.snoozedUntil ? Number(existing.snoozedUntil) : null
        const isSnoozed = existingState === "snoozed" && Number.isFinite(snoozedUntil) && snoozedUntil > now

        if (isSnoozed) {
          byId.set(id, { ...existing, active: true })
          continue
        }

        const lastFiredAt = existing?.lastFiredAt ? Number(existing.lastFiredAt) : 0
        const shouldCount = !Number.isFinite(lastFiredAt) || now - lastFiredAt > INCIDENT_COOLDOWN_MS

        const lastNotifiedAt = existing?.lastNotifiedAt ? Number(existing.lastNotifiedAt) : 0
        const shouldNotify =
          Boolean(alertRouting?.enableOutbound) &&
          (!Number.isFinite(lastNotifiedAt) || now - lastNotifiedAt > NOTIFY_COOLDOWN_MS)

        const severity = reasonToSeverity(reason)
        const nextState = existingState === "resolved" ? "open" : existingState

        const next = {
          id,
          projectId,
          reason,
          severity,
          state: nextState,
          count: shouldCount ? Number(existing?.count || 0) + 1 : Number(existing?.count || 0),
          createdAt: existing?.createdAt || now,
          updatedAt: shouldCount ? now : existing?.updatedAt || now,
          lastFiredAt: shouldCount ? now : existing?.lastFiredAt || now,
          snoozedUntil: nextState === "snoozed" ? snoozedUntil : null,
          active: true,
          lastNotifiedAt: shouldNotify ? now : existing?.lastNotifiedAt || null,
        }

        byId.set(id, next)
        if (shouldNotify) outbound.push(next)
      }

      const nextList = Array.from(byId.values()).map((inc) => {
        if (!inc) return inc
        if (inc.projectId !== projectId) return { ...inc, active: Boolean(inc.active) }
        return { ...inc, active: firing.has(inc.reason) }
      })

      writeAlertIncidents(nextList)
      return nextList
    })

    if (outbound.length) {
      outbound.forEach((inc) => {
        void dispatchOutbound({ routing: alertRouting, incident: inc, statusValue })
      })
    }
  }, [alertRouting, alertRules, projectId, reasons, status, statusValue, writeAlertIncidents])

  const renameDraftProjectId = useCallback((oldId, newId) => {
    const from = String(oldId || "").trim()
    const to = String(newId || "").trim()
    if (!from || !to || from === to) return

    const existing = Array.isArray(pendingProjectRenamesRef.current) ? pendingProjectRenamesRef.current : []
    let chained = false
    const nextRenames = existing
      .map((r) => {
        const rFrom = String(r?.from || "").trim()
        const rTo = String(r?.to || "").trim()
        if (rFrom && rTo && rTo === from) {
          chained = true
          return { from: rFrom, to }
        }
        return r
      })
      .filter((r) => String(r?.from || "").trim() !== from)

    if (!chained) {
      nextRenames.push({ from, to })
    }

    pendingProjectRenamesRef.current = nextRenames

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
      return next
    })

    setDraftPolicies((prev) => {
      const arr = Array.isArray(prev) ? prev : []
      const next = arr.map((p) => {
        if (!p) return p
        if (p.projectId !== from) return p
        return { ...p, projectId: to }
      })
      return next
    })
  }, [])

  if (isPublicStatusPage) {
    const pid = String(statusPathProjectId || "").trim()
    const openConsoleHref = `/console?project=${encodeURIComponent(pid)}`
    const projectName = publicStatus?.onchain?.project?.name || pid

    return (
      <PublicStatusPage
        projectId={pid}
        projectName={projectName}
        status={publicStatus}
        busy={publicBusy}
        error={publicError}
        lastUpdatedAt={publicLastUpdatedAt}
        openConsoleHref={openConsoleHref}
        notFound={publicNotFound}
      />
    )
  }

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
          <button className="btn btn-ghost" disabled={busy} onClick={() => setWizardOpen(true)}>
            Start Wizard
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setProjectsModalOpen(true)}>
            Projects
          </button>
          <button className="btn btn-ghost" disabled={effectiveBusy} onClick={publishDrafts}>
            Publish Drafts
          </button>
          <select
            className="project-select"
            value={activeEnv}
            onChange={(e) => {
              const next = e.target.value === "draft" ? "draft" : "live"
              setActiveEnv(next)
              if (projectId) writeUrlProject(projectId, { draft: next === "draft" })
            }}
            disabled={busy}
          >
            <option value="live" disabled={!hasLiveConfig}>
              Live
            </option>
            <option value="draft">Draft</option>
          </select>
          <select
            className="project-select"
            value={projectId || ""}
            onChange={(e) => {
              const nextId = e.target.value || null
              setProjectId(nextId)
              const nextHasLive = nextId ? (projectsRef.current || []).some((p) => p && p.id === nextId) : false
              if (nextId && !nextHasLive) {
                setActiveEnv("draft")
                writeUrlProject(nextId, { draft: true })
              } else if (nextId) {
                writeUrlProject(nextId, { draft: activeEnv === "draft" })
              }
            }}
            disabled={busy}
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
            {draftOnlyProjects.length > 0 && (
              <optgroup label="Draft">
                {draftOnlyProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            className="btn btn-primary"
            disabled={effectiveBusy}
            onClick={() => {
              if (!projectId) return
              if (!isLiveProject) {
                void refreshClientStatus()
                return
              }
              void withAction(
                async () => {},
                projectId,
                activeTab === "audit" || activeTab === "report" ? { forceHistory: true } : null
              )
            }}
          >
            {effectiveBusy ? "Syncing..." : "Refresh"}
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
          {projectId && <StatusPill status={statusValue} />}
          {effectiveBusy && <span className="env-pill env-mode">Syncing…</span>}
          {projectId && <span className="env-pill env-mode">Mode: {status?.mode || "--"}</span>}
          {projectId && (
            <span className={`env-pill ${rpcHealthy ? "env-ok" : "env-bad"}`}>
              RPC: {rpcHealthy ? (rpcBlock ? `ok @ ${rpcBlock}` : "ok") : "error"}
            </span>
          )}
          {!isLiveProject && projectId && <span className="env-pill env-warn">Not deployed</span>}
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

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
            <div className="wizard-first-run">
              <button className="btn btn-primary" onClick={() => setWizardOpen(true)}>
                Start Wizard
              </button>
              <button className="btn btn-ghost" onClick={() => setProjectsModalOpen(true)}>
                Open Projects
              </button>
            </div>
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
            busy={effectiveBusy}
            reasons={reasons}
          />

          <Tabs tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />

          <main className="main-content">
            <section
              id="panel-monitor"
              role="tabpanel"
              aria-labelledby="tab-monitor"
              hidden={activeTab !== "monitor"}
              tabIndex={-1}
            >
              {activeTab === "monitor" && (
                <OverviewTab
                  derived={derived}
                  receiver={receiver}
                  token={token}
                  mode={status?.mode}
                  busy={effectiveBusy}
                />
              )}
            </section>

            <section
              id="panel-connectors"
              role="tabpanel"
              aria-labelledby="tab-connectors"
              hidden={activeTab !== "connectors"}
              tabIndex={-1}
            >
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
                  busy={effectiveBusy}
                />
              )}
            </section>

            <section
              id="panel-alerts"
              role="tabpanel"
              aria-labelledby="tab-alerts"
              hidden={activeTab !== "alerts"}
              tabIndex={-1}
            >
              {activeTab === "alerts" && (
                <AlertsTab
                  projectId={projectId}
                  isLiveProject={isLiveProject}
                  serverIncident={incident}
                  routing={alertRouting}
                  onSaveRouting={saveAlertRouting}
                  rules={alertRules}
                  onSaveRules={saveAlertRules}
                  incidents={alertIncidents}
                  onAcknowledge={acknowledgeIncident}
                  onSnooze={snoozeIncident}
                  onResolve={resolveIncident}
                  onReopen={reopenIncident}
                  onClearResolved={clearResolvedIncidents}
                  busy={effectiveBusy}
                />
              )}
            </section>

            <section
              id="panel-policy"
              role="tabpanel"
              aria-labelledby="tab-policy"
              hidden={activeTab !== "policy"}
              tabIndex={-1}
            >
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
                  busy={effectiveBusy}
                />
              )}
            </section>

            <section
              id="panel-onchain"
              role="tabpanel"
              aria-labelledby="tab-onchain"
              hidden={activeTab !== "onchain"}
              tabIndex={-1}
            >
              {activeTab === "onchain" && (
                <OnchainTab onchain={status?.onchain} links={status?.links} busy={effectiveBusy} />
              )}
            </section>

            <section
              id="panel-report"
              role="tabpanel"
              aria-labelledby="tab-report"
              hidden={activeTab !== "report"}
              tabIndex={-1}
            >
              {activeTab === "report" && (
                <ReportTab
                  projectId={projectId}
                  isLiveProject={isLiveProject}
                  status={status}
                  history={history}
                  historyMeta={historyMeta}
                  busy={effectiveBusy}
                />
              )}
            </section>

            <section
              id="panel-audit"
              role="tabpanel"
              aria-labelledby="tab-audit"
              hidden={activeTab !== "audit"}
              tabIndex={-1}
            >
              {activeTab === "audit" && (
                <HistoryTab
                  projectId={projectId}
                  isLiveProject={isLiveProject}
                  history={history}
                  historyMeta={historyMeta}
                  busy={effectiveBusy}
                />
              )}
            </section>
          </main>
        </>
      )}

      <ProjectsModal
        open={projectsModalOpen}
        onClose={() => setProjectsModalOpen(false)}
        serverProjects={projects}
        draftProjects={draftProjects}
        draftConnectors={draftConnectors}
        draftPolicies={draftPolicies}
        onSaveDraftConnectors={saveDraftConnectors}
        onSaveDraftPolicies={saveDraftPolicies}
        onSaveDraftProjects={saveDraftProjects}
        onRenameDraftProjectId={renameDraftProjectId}
        activeProjectId={projectId}
        onSelectProjectId={(id) => setProjectId(id || null)}
      />

      <OnboardingWizardModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        serverProjects={projects}
        draftProjects={draftProjects}
        draftConnectors={draftConnectors}
        draftPolicies={draftPolicies}
        onSaveDraftProjects={saveDraftProjects}
        onSaveDraftConnectors={saveDraftConnectors}
        onSaveDraftPolicies={saveDraftPolicies}
        onSelectProjectId={(id) => setProjectId(id || null)}
      />

      <footer className="footer">
        <span>ReserveWatch Console</span>
        <span>Chainlink CRE Hackathon 2026</span>
      </footer>
    </div>
  )
}
