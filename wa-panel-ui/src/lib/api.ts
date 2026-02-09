import axios from "axios";
import { withWs } from "./workspace";

export function getApiBase(): string {
  return localStorage.getItem("wa_api_base") || "http://127.0.0.1:3001";
}

const ACTIVE_WS_KEY = "wa_active_ws";

export function setActiveWs(wsId: string) {
  if (wsId) {
    localStorage.setItem(ACTIVE_WS_KEY, wsId);
  } else {
    localStorage.removeItem(ACTIVE_WS_KEY);
  }
}

export const http = axios.create({
  baseURL: getApiBase(),
  timeout: 30000,
});

http.interceptors.request.use((config) => {
  const wsId = localStorage.getItem(ACTIVE_WS_KEY);
  if (wsId) {
    config.headers = config.headers ?? {};
    config.headers["x-ws"] = wsId;
  }
  if (config.url) {
    config.url = withWs(config.url);
  }
  return config;
});

export function setApiBase(base: string) {
  localStorage.setItem("wa_api_base", base);
  http.defaults.baseURL = base;
}
