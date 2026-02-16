const normalizeStatus = (value) => {
  const v = String(value || "").trim().toUpperCase()
  if (v === "HEALTHY" || v === "DEGRADED" || v === "UNHEALTHY" || v === "STALE") return v
  return "UNKNOWN"
}

const classByStatus = {
  HEALTHY: "env-ok",
  DEGRADED: "env-warn",
  UNHEALTHY: "env-bad",
  STALE: "env-bad",
  UNKNOWN: "env-mode",
}

export default function StatusPill({ status }) {
  const normalized = normalizeStatus(status)
  const cls = classByStatus[normalized] || "env-mode"
  const label = normalized === "UNKNOWN" ? "--" : normalized

  return <span className={`env-pill ${cls}`}>{label}</span>
}
