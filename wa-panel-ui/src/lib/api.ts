import axios from "axios";
import { getWsId, withWs } from "./workspace";

export function getApiBase(): string {
  return localStorage.getItem("wa_api_base") || "http://127.0.0.1:3001";
}

export const http = axios.create({
  baseURL: getApiBase(),
  timeout: 30000,
});

http.interceptors.request.use((config) => {
  const wsId = getWsId();
  config.headers = config.headers ?? {};
  const h: any = config.headers as any;
  if (typeof h.set === "function") h.set("x-ws", wsId);
  else h["x-ws"] = wsId;

  if (config.url) {
    config.url = withWs(config.url); // 现在 withWs 会追加 ?ws=6688 且不改域名
  }
  return config;
});


export function setApiBase(base: string) {
  localStorage.setItem("wa_api_base", base);
  http.defaults.baseURL = base;
}
