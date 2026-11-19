import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  raiseSocketSendBuffer,
  socketBufferSizes,
} from "./internal/socket-buffer";
export type {
  SendBufferRaise,
  SocketBufferSizes,
} from "./internal/socket-buffer";

export default {
  description:
    "A connected socket's kernel send buffer, read and raised through bun:ffi on macOS and Linux: socketBufferSizes(socket) reads SO_SNDBUF / SO_RCVBUF, raiseSocketSendBuffer(socket, bytes) raises SO_SNDBUF to at least bytes and never lowers it. On a macOS Unix stream socket the sender's SO_SNDBUF (8 KB by default) bounds what is in flight, so a large write leaves one buffer per event-loop turn.",
} satisfies MachinePluginDefinition;
