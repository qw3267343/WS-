import { http } from "./api";
import { ACCESS_TOKEN_KEY } from "./auth";

let inited = false;

export function initAuthHttp() {
  if (inited) return;
  inited = true;

  http.interceptors.request.use((config) => {
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!token) return config;

    config.headers = config.headers ?? {};
    const h: any = config.headers as any;
    if (typeof h.set === "function") h.set("Authorization", `Bearer ${token}`);
    else h.Authorization = `Bearer ${token}`;

    return config;
  });
}
