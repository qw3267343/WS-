import { io, Socket } from "socket.io-client";
import { getApiBase } from "./api";
let socket: Socket | null = null;
let socketWs = "";

export function getSocket(wsId: string): Socket {
  const nextWs = String(wsId || "").trim() || "default";
  if (socket && socketWs !== nextWs) {
    socket.disconnect();
    socket = null;
  }
  if (!socket) {
    socket = io(getApiBase(), {
      transports: ["polling", "websocket"],
      autoConnect: true,
      query: { ws: nextWs },
    });
    socketWs = nextWs;
  }
  return socket;
}

export function resetSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  socketWs = "";
}
