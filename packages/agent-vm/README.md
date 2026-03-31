# agent-vm

Run `pi` sandboxed in a [Firecracker](https://github.com/firecracker-microvm/firecracker) microVM via [vmsan](https://vmsan.dev).

`vmpi` feels just like `pi`, but the agent runs in hardware-isolated sandbox with access to only:

- the **current directory** (mounted read-write at `/workspace`)
- `~/.pi` config (mounted at `/root/.pi`)
- LLM provider APIs (configurable network allowlist)
- nothing else — no rest of the filesystem

**Resources:** 256 MiB RAM · 1 vCPU · network restricted to configured provider domains

## Requirements

- Linux (x86_64) with KVM support (`/dev/kvm`)
- `vmsan` installed (`npm install -g vmsan` or `curl -fsSL https://vmsan.dev/install | bash`)
- `sudo` access (Firecracker's jailer requires root)
- `pi` binary at `/opt/pi-coding-agent/pi` (override with `$PI_BINARY`)
- `tar`, `python3`

## Install

```bash
npm install -g @the-agency/agent-vm
# or link locally:
cd packages/agent-vm && npm link
```

## Usage

```bash
# first run — auto-builds a base snapshot (installs pi via npm, ~200 MiB)
vmpi

# subsequent runs boot in ~200 ms from the cached snapshot
vmpi "refactor the auth module to use JWTs"

# force rebuild of the base snapshot (e.g. to upgrade pi)
vmpi setup

# show snapshot id and running VMs
vmpi status
```

Every invocation:

1. Creates an ephemeral VM from the base snapshot (network: allow-all)
2. Uploads the **current directory** (minus `.git`, `node_modules`, `dist`) → `/workspace`
3. Uploads `~/.pi` → `/root/.pi`
4. Uploads any existing pi sessions for the current directory, renamed for `/workspace`
5. Runs `pi update` to install any pi packages listed in the config
6. Applies the configured network policy (provider allowlist)
7. Runs `pi [args]` interactively inside the VM
8. Downloads sessions created inside the VM back to the host
9. Stops and removes the VM when pi exits

## Configuration

vmpi is configured via a config file (powered by [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)).
It searches for configuration in the following locations:

- `vmpi` key in `package.json`
- `.vmpirc` (JSON or YAML)
- `.vmpirc.json`, `.vmpirc.yaml`, `.vmpirc.yml`
- `vmpi.config.js`, `vmpi.config.cjs`

### Example `.vmpirc.json`

```json
{
  "memory": 512,
  "cpus": 2,
  "network": {
    "providers": ["github-copilot", "anthropic"],
    "allowedDomains": ["my-custom-llm.example.com"]
  }
}
```

### Options

| Key | Default | Description |
|---|---|---|
| `memory` | `256` | RAM in MiB |
| `cpus` | `1` | vCPU count |
| `piConfigDir` | `~/.pi` | Path to the pi config directory on the host |
| `stateDir` | `~/.vmpi` | Where vmpi stores the base snapshot ID |
| `network.policy` | inferred | `"allow-all"`, `"deny-all"`, or `"custom"`. Auto-set to `"custom"` when providers/domains are configured |
| `network.providers` | `[]` | LLM provider names to allow (see below) |
| `network.allowedDomains` | `[]` | Additional domains/patterns to allow |

Environment variables (`VMPI_MEMORY`, `VMPI_CPUS`, `PI_CONFIG_DIR`, `VMPI_STATE_DIR`) override their config file equivalents.

### Built-in providers

| Provider | Allowed domains |
|---|---|
| `github-copilot` | `api.githubcopilot.com`, `*.github.com`, `api.github.com`, `copilot-proxy.githubusercontent.com` |
| `gemini` | `generativelanguage.googleapis.com`, `*.googleapis.com` |
| `openai` | `api.openai.com` |
| `anthropic` | `api.anthropic.com` |
| `ollama` | `localhost`, `127.0.0.1` |

Multiple providers can be combined. Their domains are merged with any `allowedDomains`.

## How it works

vmsan uses Firecracker microVMs with a jailer, seccomp filters, and per-VM network namespaces.
`vmpi` builds a **base snapshot** once by booting a VM with the vmsan `node24` runtime, running `npm install -g @mariozechner/pi-coding-agent`, bootstrapping pip, then snapshotting it.
Future runs restore from that snapshot in ~200 ms, upload the current directory and config as tarballs, run `pi update` to sync packages, then exec pi with a full PTY inside the VM.

The runtime VM starts with full network access for `pi update`, then switches to the configured
network policy before pi runs. By default (no config file), the policy is `deny-all`.

### Session continuity

Pi stores sessions under `~/.pi/agent/sessions/` using a directory name derived from the project path.
Because the project is always mounted at `/workspace` inside the VM, vmpi translates session
directories on both sides:

- **Before launch:** any existing host sessions for the current working directory are uploaded to
  the VM as `/root/.pi/agent/sessions/--workspace--/`, so `pi --continue` works seamlessly.
- **After exit:** sessions created or updated inside the VM are downloaded back to the host and
  stored under the host CWD's session directory, merging without overwriting existing files.

## Limitations and future direction

### Elevated privileges

The current implementation depends on [vmsan](https://vmsan.dev), which requires `sudo` for two reasons:

- **TAP networking:** vmsan creates a TAP device and configures nftables rules inside a per-VM network namespace. Both operations require `CAP_SYS_ADMIN`/`CAP_NET_ADMIN`, which means root.
- **Firecracker jailer:** vmsan uses Firecracker's jailer to harden the sandbox (cgroups, chroot, seccomp). The jailer itself is a setuid binary that drops privileges after setup, but launching it requires root.

vmsan is a working proof-of-concept that demonstrates the overall approach, but the sudo requirement is a significant usability friction -- particularly when running vmpi from within a pi agent session, where a password prompt is invisible.

### Path to rootless operation

Firecracker itself only needs access to `/dev/kvm` (typically group-readable without sudo on most Linux distros) and a writable disk image. The root requirement comes entirely from the networking layer. A rootless implementation would replace vmsan with direct Firecracker management and substitute TAP+nftables with [pasta](https://passt.top/), a user-space networking tool designed specifically for rootless VMs and containers.

The architecture would look like this:

- **Firecracker** launched directly against `/dev/kvm` -- no jailer, no sudo. The jailer currently provides chroot confinement, cgroup limits, UID separation, and per-VM network namespaces on top of Firecracker's own seccomp filter. Dropping it means a successful VM escape (currently theoretical against a patched Firecracker) would land in the host user's full filesystem context rather than a chrooted directory with no credentials or sensitive files reachable. Firecracker's seccomp filter -- which is retained -- is the strongest single mitigation and makes escapes extremely difficult; the jailer is defense-in-depth on top of that. The tradeoff is acceptable for a developer sandbox used against your own code, but worth reconsidering for untrusted or adversarial inputs.
- **pasta** replaces TAP networking. pasta runs as the current user and bridges the VM's virtio-net interface to the host network via a user-space TCP/IP relay. Latency overhead versus TAP is roughly 2-3x for local traffic, but in practice unnoticeable for LLM API calls that are dominated by remote round-trip time.
- **Network policy** (the provider allowlist) would move from nftables rules in the VM's network namespace to a small filtering proxy that pasta's traffic is routed through -- either a local SOCKS5/HTTP proxy that enforces the domain allowlist, or eBPF-based filtering if available.
- **The in-VM agent** (currently vmsan's `vmsan-agent` binary) would need to be replaced or supplemented. vmsan-agent is a Go HTTP server that handles file transfer and command execution; a minimal equivalent could be built as part of this package, or an existing rootfs with a compatible agent could be used.

The vmsan dependency could be dropped incrementally: the snapshot and VM lifecycle management can be replaced first (using Firecracker's API socket directly), with pasta substituted for networking in a second pass. The file transfer and exec protocol would need to stay compatible with whatever agent binary ends up in the rootfs.
