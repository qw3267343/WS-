export function getWsId(): string {
  const params = new URLSearchParams(window.location.search);
  const ws = (params.get("ws") || "").trim();
  return ws || "default";
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
