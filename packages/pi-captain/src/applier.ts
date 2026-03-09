/**
 * Sandboxed pi sub-agent launcher.
 *
 * Spawned as a child process by the spawn_agent extension tool. Reads CaptainConfig
 * from CAPTAIN_CONFIG, applies a kernel-enforced sandbox via nono-ts (Landlock on
 * Linux, Seatbelt on macOS), then execs pi in print mode with only the child proxy
 * extension loaded. The child pi session inherits the sandbox.
 *
 * The child extension connects back to the parent over a Unix domain socket and
 * forwards all tool calls for the parent to execute — capabilities are never held
 * directly by the child process.
 *
 * NOTE: apply() is irreversible. This process is intentionally sacrificial.
 * Graceful fallback: missing nono-ts bindings → unsandboxed with a warning.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { CaptainConfig } from "./types.ts";

const PI_BINARY = "/opt/pi-coding-agent/pi";

const rawConfig = process.env.CAPTAIN_CONFIG;
if (!rawConfig) {
  process.stderr.write("pi-captain: CAPTAIN_CONFIG env var is missing\n");
  process.exit(1);
}

const config: CaptainConfig = JSON.parse(rawConfig);

// child pi is given no built-in tools — it gets proxy tools via the child extension only
const piArgs: string[] = [
  "-p", config.prompt,
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "-e", config.childExtensionPath,
];

if (config.model) piArgs.push("--model", config.model);
if (config.systemPrompt) piArgs.push("--system-prompt", config.systemPrompt);

// attempt to apply nono sandbox
let sandboxApplied = false;
try {
  const { CapabilitySet, AccessMode, apply, isSupported } = await import("nono-ts");

  if (isSupported()) {
    const caps = new CapabilitySet();

    const modeMap: Record<string, number> = {
      read: AccessMode.Read,
      write: AccessMode.Write,
      readwrite: AccessMode.ReadWrite,
    };

    // paths required for pi and node to execute, plus the child extension
    const required: Array<[string, number]> = [
      [PI_BINARY,                              AccessMode.Read],
      ["/opt/pi-coding-agent",                 AccessMode.Read],
      ["/usr",                                 AccessMode.Read],
      ["/lib",                                 AccessMode.Read],
      ["/lib64",                               AccessMode.Read],
      ["/proc",                                AccessMode.Read],
      ["/dev",                                 AccessMode.ReadWrite],
      ["/tmp",                                 AccessMode.ReadWrite],  // covers ipc socket
      ["/run",                                 AccessMode.Read],
      ["/sys",                                 AccessMode.Read],
      [`${homedir()}/.pi`,                     AccessMode.Read],
      [process.execPath,                       AccessMode.Read],
      [dirname(config.childExtensionPath),     AccessMode.Read],  // child-extension.ts + ipc.ts
    ];

    for (const [path, mode] of required) {
      try {
        caps.allowPath(path, mode);
      } catch {
        // path may not exist on this system — skip
      }
    }

    // always grant read/write to cwd so pi can work
    caps.allowPath(config.cwd, AccessMode.ReadWrite);

    for (const p of config.policy.allowPaths ?? []) {
      const mode = modeMap[p.mode ?? "readwrite"] ?? AccessMode.ReadWrite;
      caps.allowPath(p.path, mode);
    }
    for (const cmd of config.policy.allowCommands ?? []) caps.allowCommand(cmd);
    for (const cmd of config.policy.blockCommands ?? []) caps.blockCommand(cmd);
    if (config.policy.blockNetwork) caps.blockNetwork();

    apply(caps);
    sandboxApplied = true;
  } else {
    process.stderr.write("pi-captain: nono sandboxing not supported on this platform, running unsandboxed\n");
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pi-captain: could not load nono-ts (${msg}), running unsandboxed\n`);
}

if (sandboxApplied) {
  process.stderr.write("pi-captain: nono sandbox applied\n");
}

const child = spawn(PI_BINARY, piArgs, {
  cwd: config.cwd,
  stdio: "inherit",
  env: {
    ...process.env,
    CAPTAIN_IPC_SOCKET: config.ipcSocketPath,
    CAPTAIN_TOOL_DEFS: JSON.stringify(config.toolDefs),
  },
});

child.on("error", (err) => {
  process.stderr.write(`pi-captain: failed to spawn pi: ${err.message}\n`);
  process.exit(1);
});

child.on("exit", (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  else process.exit(code ?? 0);
});
