/**
 * NDJSON framing for IPC between parent and child pi processes.
 * JSON.stringify escapes all internal newlines, so a literal `\n` is a safe frame delimiter.
 */

import type { Socket } from "node:net";
import type { IpcMessage } from "./types.ts";

export function writeMessage(socket: Socket, msg: IpcMessage): void {
  socket.write(JSON.stringify(msg) + "\n");
}

/**
 * Attaches a data handler that parses newline-delimited JSON frames from the
 * socket and calls `onMessage` for each complete frame. Returns a cleanup function.
 */
export function readMessages(
  socket: Socket,
  onMessage: (msg: IpcMessage) => void,
): () => void {
  let buf = "";

  const onData = (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          onMessage(JSON.parse(line) as IpcMessage);
        } catch {
          // malformed frame — skip
        }
      }
    }
  };

  socket.on("data", onData);
  return () => socket.off("data", onData);
}
