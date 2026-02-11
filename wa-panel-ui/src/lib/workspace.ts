export function getWsId(): string {
  // ✅ 1) HashRouter（Electron/HashRouter）：#/w/6688/tasks
  const hash = (window.location.hash || "").trim();
  const hashMatch = hash.match(/^#\/w\/([^\/?#]+)/);
  if (hashMatch?.[1]) return decodeURIComponent(hashMatch[1]);

  // ✅ 2) BrowserRouter：/w/6688/tasks
  const pathMatch = window.location.pathname.match(/^\/w\/([^\/?#]+)/);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);

  // ✅ 3) URL query：?ws=6688
  const params = new URLSearchParams(window.location.search);
  const wsFromQuery = (params.get("ws") || "").trim();
  if (wsFromQuery) return wsFromQuery;

  // ✅ 4) hash 内也可能带 query：#/xxx?ws=6688
  const hashQuery = hash.includes("?") ? hash.split("?")[1] : "";
  if (hashQuery) {
    const hp = new URLSearchParams(hashQuery);
    const wsFromHashQuery = (hp.get("ws") || "").trim();
    if (wsFromHashQuery) return wsFromHashQuery;
  }

  // ✅ 5) localStorage fallback
  const saved = localStorage.getItem("wa_active_ws");
  return (saved || "").trim() || "default";
}

export function wsKey(key: string): string {
  return `ws:${getWsId()}:${key}`;
}

export function withWs(url: string): string {
  const ws = getWsId();
  if (!ws) return url;

  // 不改域名，只追加 ?ws=
  const [base, hash] = url.split("#");

  // 已有 ws 参数就不重复追加
  const qIndex = base.indexOf("?");
  const pathPart = qIndex >= 0 ? base.slice(0, qIndex) : base;
  const queryPart = qIndex >= 0 ? base.slice(qIndex + 1) : "";

  const params = new URLSearchParams(queryPart);
  if (params.has("ws")) return url;

  params.set("ws", ws);

  const rebuiltBase = params.toString()
    ? `${pathPart}?${params.toString()}`
    : pathPart;

  return hash ? `${rebuiltBase}#${hash}` : rebuiltBase;
}
