import axios from "axios";
import { withWs } from "./workspace";

export function getApiBase(): string {
  return localStorage.getItem("wa_api_base") || "http://127.0.0.1:3001";
}

export const http = axios.create({
  baseURL: getApiBase(),
  timeout: 30000,
});

http.interceptors.request.use((config) => {
  if (config.url) {
    config.url = withWs(config.url);
  }
  return config;
});

export function setApiBase(base: string) {
  localStorage.setItem("wa_api_base", base);
  http.defaults.baseURL = base;
}
