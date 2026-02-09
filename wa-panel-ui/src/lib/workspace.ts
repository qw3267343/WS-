export function getWsId(): string {
  const pathMatch = window.location.pathname.match(/^\/w\/([^\/?#]+)/);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);
  const params = new URLSearchParams(window.location.search);
  const ws = (params.get("ws") || "").trim();
  if (ws) return ws;
  const saved = localStorage.getItem("wa_active_ws");
  return (saved || "").trim() || "default";
}

export function wsKey(key: string): string {
  return `ws:${getWsId()}:${key}`;
}

export function withWs(url: string): string {
  const ws = getWsId();
  if (!ws) return url;
  if (url.includes("ws=")) return url;
  const [base, hash] = url.split("#");
  const join = base.includes("?") ? "&" : "?";
  const next = `${base}${join}ws=${encodeURIComponent(ws)}`;
  return hash ? `${next}#${hash}` : next;
}
