import { io, Socket } from "socket.io-client";
import { getApiBase } from "./api";
let socket: Socket | null = null;

export function getSocket(wsId: string): Socket {
  if (!socket) {
    socket = io(getApiBase(), {
      transports: ["polling", "websocket"],
      autoConnect: true,
      query: { ws: wsId },
    });
  }
  return socket;
}

export function resetSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
