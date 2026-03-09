/**
 * Child proxy extension for pi-captain.
 *
 * Loaded by the sandboxed child pi process via `-e`. Reads the IPC socket path
 * and serialized tool definitions from env vars, then registers a proxy tool for
 * each authorized capability. When the LLM calls a proxy tool, the extension
 * forwards the call to the parent over the Unix domain socket and awaits the
 * result — the parent executes the real tool and sends back the outcome.
 *
 * The child never runs tools directly; it holds references that the parent
 * honours. This is the OCapN-style capability-by-reference model.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { readMessages, writeMessage } from "./ipc.ts";
import type {
  ToolDefinition,
  ToolCallResult,
  ToolCallUpdate,
  ToolCallError,
} from "./types.ts";

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.CAPTAIN_IPC_SOCKET;
  if (!socketPath) {
    process.stderr.write("pi-captain child: CAPTAIN_IPC_SOCKET not set — no tools available\n");
    return;
  }

  const rawDefs = process.env.CAPTAIN_TOOL_DEFS;
  if (!rawDefs) {
    process.stderr.write("pi-captain child: CAPTAIN_TOOL_DEFS not set — no tools available\n");
    return;
  }

  const toolDefs: ToolDefinition[] = JSON.parse(rawDefs);

  const socket = createConnection(socketPath);

  // pending requests: id → resolve/reject/onUpdate
  type PendingEntry = {
    resolve: (result: ToolCallResult) => void;
    reject: (err: Error) => void;
    onUpdate?: (u: { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }) => void;
  };
  const pending = new Map<string, PendingEntry>();

  readMessages(socket, (msg) => {
    if (msg.type === "tool_result") {
      const r = msg as ToolCallResult;
      const entry = pending.get(r.id);
      if (entry) {
        pending.delete(r.id);
        entry.resolve(r);
      }
    } else if (msg.type === "tool_update") {
      const u = msg as ToolCallUpdate;
      pending.get(u.id)?.onUpdate?.({ content: u.content, details: u.details });
    } else if (msg.type === "tool_error") {
      const e = msg as ToolCallError;
      const entry = pending.get(e.id);
      if (entry) {
        pending.delete(e.id);
        entry.reject(new Error(e.message));
      }
    }
  });

  socket.on("error", (err) => {
    process.stderr.write(`pi-captain child: IPC socket error: ${err.message}\n`);
    for (const { reject } of pending.values()) reject(new Error(`IPC socket error: ${err.message}`));
    pending.clear();
  });

  for (const def of toolDefs) {
    pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      // TypeBox schemas are plain JSON Schema objects; passing deserialized JSON is safe
      parameters: def.parameters as any,

      async execute(_toolCallId, params, signal, onUpdate) {
        const id = randomUUID();

        const result = await new Promise<ToolCallResult>((resolve, reject) => {
          pending.set(id, {
            resolve,
            reject,
            onUpdate: onUpdate
              ? (u) => onUpdate({ content: u.content as any, details: u.details })
              : undefined,
          });

          writeMessage(socket, {
            type: "tool_call",
            id,
            toolName: def.name,
            params: params as Record<string, unknown>,
          });

          signal?.addEventListener("abort", () => {
            pending.delete(id);
            reject(new Error("tool call aborted"));
          });
        });

        // throwing causes pi's agent loop to set isError=true on the tool result
        if (result.isError) {
          const msg = result.content.map((c) => c.text).join("");
          throw new Error(msg || "tool execution failed");
        }

        return {
          content: result.content as any,
          details: result.details ?? {},
        };
      },
    });
  }
}
