import { io, Socket } from "socket.io-client";
import { getApiBase } from "./api";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(getApiBase(), { transports: ["polling", "websocket"], autoConnect: true });
  }
  return socket;
}

export function resetSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
