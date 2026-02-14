const ACTIVE_WS_KEY = "wa_active_ws";

export function getWsId(): string {
  // ✅ 1) URL query：?ws=...
  const params = new URLSearchParams(window.location.search);
  const wsFromQuery = (params.get("ws") || "").trim();
  if (wsFromQuery) return wsFromQuery;

  const hash = String(window.location.hash || "").trim();

  // ✅ 2) hash 内 query：#/xxx?ws=...
  if (hash.includes("?")) {
    const q = hash.split("?").slice(1).join("?");
    const hp = new URLSearchParams(q);
    const wsFromHashQuery = (hp.get("ws") || "").trim();
    if (wsFromHashQuery) return wsFromHashQuery;
  }

  // ✅ 3) HashRouter path：#/w/<wsId>/...
  const hashMatch = hash.match(/#\/w\/([^\/?#]+)/);
  if (hashMatch?.[1]) return decodeURIComponent(hashMatch[1]);

  // ✅ 4) BrowserRouter：/w/<wsId>/...
  const pathMatch = String(window.location.pathname || "").match(/^\/w\/([^\/?#]+)/);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);

  // ✅ 5) localStorage fallback
  const saved = localStorage.getItem(ACTIVE_WS_KEY);
  return (saved || "").trim() || "default";
}

export function setActiveWs(wsId: string) {
  const next = String(wsId || "").trim();
  if (next) localStorage.setItem(ACTIVE_WS_KEY, next);
  else localStorage.removeItem(ACTIVE_WS_KEY);
}

export function wsKey(key: string): string {
  return `ws:${getWsId()}:${key}`;
}

export function withWs(url: string): string {
  if (!url) return url;

  const ws = getWsId();
  if (!ws) return url;

  // 允许传 "/api/xxx"、"api/xxx"、"http://127.0.0.1:3001/api/xxx"
  const [base, hash] = url.split("#");

  const qIndex = base.indexOf("?");
  const pathPart = qIndex >= 0 ? base.slice(0, qIndex) : base;
  const queryPart = qIndex >= 0 ? base.slice(qIndex + 1) : "";

  const params = new URLSearchParams(queryPart);
  if (!params.has("ws")) params.set("ws", ws);

  const rebuiltBase = params.toString() ? `${pathPart}?${params.toString()}` : pathPart;
  return hash ? `${rebuiltBase}#${hash}` : rebuiltBase;
}
