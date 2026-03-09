# pi-captain

A Pi extension that uses an OCapN-style model for spawning sandboxed sub-agents in forked child processes as actors that are only permitted to perform actions explicitly sanctioned by their parent process.

## What it does

1. The extension provides a `spawn_agent` tool, which establishes a list of tasks to be performed by sub-agents. (TBD on how this list is established)
2. It spawns a child process that has an aggressive sandbox policy applied (no network, files are read-only, etc.), as well as a list of tools the child can use, which are passed "by reference" only. The parent process also determines the system prompt, task prompt, model, and working directory on behalf of the child.
3. The child agent works on its task, and when it needs to perform one of the sanctioned functions, it sends an IPC message to the parent with the function name and arguments, which the parent then runs, and sends an message back on completion with any return value, error state, etc.

### Sandboxing

The sandbox policy is enforced at the OS level using [nono](https://github.com/always-further/nono) via [nono-ts](https://github.com/always-further/nono-ts), which uses  **Landlock** on Linux (kernel 5.13+) and **Seatbelt** on macOS. Once applied, the kernel blocks any access outside the declared capabilities. There is no way to escape via prompt injection or shell tricks.

## Architecture

```
Parent pi session
  └── spawn_agent tool call
        └── calls applier.ts (child process) with all arguments
              ├── builds and applies CapabilitySet from config + required system paths
              └── forks process calling child.ts module
                    └── pi sub-agent inherits sandbox
```

The `applier.ts` is a sacrificial process: it applies the sandbox to itself and then forks, so the sub-agent process will inherit the sandbox policy restrictions.

## Default sandbox paths

The following paths are always granted (required for pi to run):

| Path | Access |
|------|--------|
| `/opt/pi-coding-agent` | read |
| `/usr`, `/lib`, `/lib64` | read |
| `/proc`, `/sys` | read |
| `/dev` | read/write |
| `/tmp` | read/write |
| `/run` | read |
| `~/.pi` | read |
| sub-agent `cwd` | read/write |

Additional paths are granted via the `policy.allowPaths` parameter.

## Usage

Once installed, the parent agent can call `spawn_agent`:

```
Spawn a sub-agent to audit the /src directory for security issues.
Use model anthropic/claude-sonnet-4-5, restrict it to the read tool only,
block network access, and limit filesystem access to /src.
```

```jsonc
// Example tool call
{
  "prompt": "Audit all TypeScript files in /src for SQL injection vulnerabilities and output a report.",
  "model": "anthropic/claude-sonnet-4-5",
  "cwd": "/src",
  "tools": ["read", "grep", "find"],
  "policy": {
    "allowPaths": [{ "path": "/src", "mode": "read" }],
    "blockNetwork": true
  },
  "timeout": 60000
}
```

## Installation

TODO

## Requirements

- Node.js 22.6+ (for `--experimental-transform-types`)
- Linux kernel 5.13+ (Landlock) or macOS 10.5+ (Seatbelt) for sandboxing
- On unsupported platforms, the sub-agent runs without a sandbox and warns the user
