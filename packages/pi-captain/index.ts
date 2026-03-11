import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createReadTool,
  createBashTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { writeMessage, readMessages } from "./src/ipc.ts";
import type { CaptainConfig, ToolDefinition } from "./src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// built-in tool factories keyed by tool name
type ToolFactory = (cwd: string) => {
  name: string;
  label: string;
  description: string;
  parameters: object;
  execute: (...args: any[]) => Promise<{ content: any[]; details?: any; isError?: boolean }>;
};

const TOOL_FACTORIES: Record<string, ToolFactory> = {
  read:  createReadTool,
  bash:  createBashTool,
  write: createWriteTool,
  edit:  createEditTool,
  grep:  createGrepTool,
  find:  createFindTool,
  ls:    createLsTool,
};

const PathPolicySchema = Type.Object({
  path: Type.String({ description: "Filesystem path to allow" }),
  mode: Type.Optional(
    Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("readwrite")], {
      description: "Access mode (default: readwrite)",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Spawn a sandboxed Pi sub-agent in a forked child process. " +
      "The required `prompt` parameter is the task or question sent to the sub-agent. " +
      "The sub-agent runs with a kernel-enforced filesystem sandbox via nono " +
      "(Landlock on Linux, Seatbelt on macOS). Tools are passed by capability " +
      "reference: the child holds no direct access — all tool calls are forwarded " +
      "to the parent over a Unix domain socket and executed there. " +
      "The parent controls the prompt, model, working directory, available tools, " +
      "and the sandbox policy. All output is captured and returned.",
    promptSnippet: "Spawn a sandboxed Pi sub-agent — pass a `prompt` containing the task or question for the sub-agent to work on",
    parameters: Type.Object({
      prompt: Type.String({
        description: "Required. The task or question for the sub-agent to work on.",
      }),
      model: Type.Optional(
        Type.String({
          description: "Model to use, e.g. 'anthropic/claude-sonnet-4-5'. Defaults to the current session model.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory for the sub-agent. Defaults to the current working directory.",
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            `Built-in tools to proxy to the sub-agent (e.g. ['read', 'bash', 'write']). ` +
            `Available: ${Object.keys(TOOL_FACTORIES).join(", ")}. Defaults to all available tools.`,
        }),
      ),
      systemPrompt: Type.Optional(
        Type.String({
          description: "Override the system prompt for the sub-agent.",
        }),
      ),
      policy: Type.Optional(
        Type.Object({
          allowPaths: Type.Optional(
            Type.Array(PathPolicySchema, {
              description:
                "Additional filesystem paths to grant access to beyond the defaults. " +
                "The sub-agent's cwd is always granted read/write access automatically.",
            }),
          ),
          blockNetwork: Type.Optional(
            Type.Boolean({
              description: "Block all outbound network access from the sub-agent (default: false).",
            }),
          ),
          allowCommands: Type.Optional(
            Type.Array(Type.String(), {
              description: "Shell commands to add to the allow list (overrides any block list).",
            }),
          ),
          blockCommands: Type.Optional(
            Type.Array(Type.String(), {
              description: "Shell commands to add to the block list.",
            }),
          ),
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds before the sub-agent is killed (default: 120000).",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agentCwd = params.cwd ? resolve(params.cwd) : ctx.cwd;
      const timeout = params.timeout ?? 120_000;

      // build tool instances and definitions for authorized tools
      const requestedNames = params.tools ?? Object.keys(TOOL_FACTORIES);
      const toolInstances = new Map<string, ReturnType<ToolFactory>>();
      const toolDefs: ToolDefinition[] = [];

      for (const name of requestedNames) {
        const factory = TOOL_FACTORIES[name];
        if (factory == null) continue;
        const instance = factory(agentCwd);
        toolInstances.set(name, instance);
        toolDefs.push({
          name: instance.name,
          label: instance.label,
          description: instance.description,
          parameters: instance.parameters,
        });
      }

      // create a per-agent unix domain socket for capability forwarding
      const socketPath = `/tmp/pi-captain-${randomUUID()}.sock`;

      const server = createServer((socket) => {
        readMessages(socket, async (msg) => {
          if (msg.type !== "tool_call") return;

          const tool = toolInstances.get(msg.toolName);
          if (tool == null) {
            writeMessage(socket, {
              type: "tool_error",
              id: msg.id,
              message: `tool '${msg.toolName}' is not available to this sub-agent`,
            });
            return;
          }

          try {
            const result = await tool.execute(
              msg.id,
              msg.params,
              signal,
              (update: { content: any[]; details?: any }) => {
                writeMessage(socket, {
                  type: "tool_update",
                  id: msg.id,
                  content: update.content,
                  details: update.details,
                });
              },
            );
            writeMessage(socket, {
              type: "tool_result",
              id: msg.id,
              content: result.content,
              details: result.details,
              isError: result.isError ?? false,
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            writeMessage(socket, {
              type: "tool_result",
              id: msg.id,
              content: [{ type: "text", text: message }],
              isError: true,
            });
          }
        });
      });

      await new Promise<void>((res) => server.listen(socketPath, res));

      const config: CaptainConfig = {
        prompt: params.prompt,
        model: params.model,
        cwd: agentCwd,
        tools: requestedNames,
        systemPrompt: params.systemPrompt,
        policy: params.policy ?? {},
        timeout,
        ipcSocketPath: socketPath,
        childExtensionPath: resolve(__dirname, "src", "child-extension.ts"),
        toolDefs,
      };

      const applierPath = resolve(__dirname, "src", "applier.ts");

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      return new Promise((resolvePromise) => {
        const child = spawn(
          process.execPath,
          ["--experimental-transform-types", applierPath],
          {
            env: { ...process.env, CAPTAIN_CONFIG: JSON.stringify(config) },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 3000);
        }, timeout);

        child.stdout!.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          const preview = truncateHead(stdout, { maxLines: 50, maxBytes: 4096 });
          onUpdate?.({ content: [{ type: "text", text: preview.content }], details: {} });
        });

        child.stderr!.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on("close", async (code) => {
          clearTimeout(timer);
          server.close();
          await rm(socketPath, { force: true });

          const truncated = truncateHead(stdout, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });

          let result = truncated.content;

          if (truncated.truncated) {
            result +=
              `\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines shown` +
              ` (${truncated.outputBytes} of ${truncated.totalBytes} bytes)]`;
          }

          if (timedOut) result += `\n\n[Sub-agent timed out after ${timeout}ms]`;

          const stderrTrimmed = stderr.trim();
          if (stderrTrimmed) result += `\n\n--- stderr ---\n${stderrTrimmed.slice(-2000)}`;

          if (timedOut || (code !== null && code !== 0)) {
            result += `\n\n[Sub-agent exited with code ${code ?? "(signal)"}]`;
          }
          resolvePromise({
            content: [{ type: "text" as const, text: result || "(no output)" }],
            details: { exitCode: code, timedOut, cwd: agentCwd },
          });
        });

        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          child.kill("SIGTERM");
        });
      });
    },
  });
}
