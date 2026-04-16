# vmpi

Run `pi` sandboxed in a [QEMU](https://www.qemu.org/) microVM via [Gondolin](https://earendil-works.github.io/gondolin/).

`vmpi` feels just like `pi`, but the agent runs in a hardware-isolated sandbox with access to only:

- the **current directory** (mounted read-write at `/workspace` via VFS)
- `~/.pi` config (mounted read-only at `/root/.pi` via VFS)
- LLM provider APIs (configurable network allowlist via HTTP hooks)

...and nothing else.

**Resources:** 512 MiB RAM, 1 vCPU, network restricted to configured LLM provider domains

**No root required:** Gondolin's QEMU backend runs entirely as the current user.

## Why vmpi?

Running `pi` directly gives the agent access to your entire filesystem and unrestricted network access. That is fine for trusted, well-understood tasks, but risky for exploratory or agentic workloads where a hallucination or a bad tool call could touch files outside your project.

`vmpi` wraps [Gondolin](https://earendil-works.github.io/gondolin/), a QEMU microVM library, to give you hardware-level isolation without the setup cost. You could configure Gondolin directly, but you would need to handle all of the following yourself:

- Build and cache a base VM checkpoint so each run starts in ~1 s instead of minutes
- Mount your current directory and `~/.pi` config into the VM at the right paths
- Install `pi` inside the VM and keep it updated
- Enforce a network allowlist so the agent can reach your LLM provider but nothing else
- Translate `~/.pi/agent/sessions/` directories so prior conversation history is visible inside the VM and new sessions are written back to the host

`vmpi` handles all of that. From the outside it feels like typing `pi`.

## Requirements

- Linux (x86_64) with KVM support (`/dev/kvm`)
- `qemu-system-x86_64`
  - Arch: `sudo pacman -S qemu-system-x86`
  - Ubuntu: `sudo apt install qemu-system-x86`
- `qemu-img`
  - Arch: `sudo pacman -S qemu-img`
  - Ubuntu: `sudo apt install qemu-utils`

## Install

```bash
npm install -g @the-agency/vmpi

# or clone and link locally:
cd packages/vmpi
npm install
npm run build
npm link
```

## Usage

```bash
# first run: builds a base VM checkpoint (downloads pi, ~5 min)
vmpi setup

# subsequent runs resume from the checkpoint in ~1 s
vmpi "refactor the auth module to use JWTs"

# rebuild the base checkpoint (e.g. to upgrade pi)
vmpi setup

# show checkpoint status
vmpi status

# enable Gondolin debug logging
vmpi setup --debug
vmpi --debug
```

Every `vmpi` invocation:

1. Resumes an ephemeral VM from the base checkpoint (network: configured policy, VFS mounts)
2. Mounts the **current directory** at `/workspace`
3. Mounts `~/.pi` at `/root/.pi`
4. Runs `pi update` to install any pi packages listed in the config
5. Prepares Pi session history: symlinks `~/.pi/agent/sessions/` subdirectory to host CWD session dir
6. Runs `pi [args]` interactively inside the VM with a full PTY
7. Collects sessions written during the run back to the host
8. Closes the VM when pi exits

`vmpi setup`:

1. Downloads the pi tarball on the host (cached in `~/.vmpi/cache/`)
2. Boots a fresh VM and writes the tarball into it
3. Runs `npm install -g` inside the VM
4. Creates a qcow2 disk checkpoint at `~/.vmpi/base-checkpoint.qcow2`

## Configuration

vmpi can be configured with a config file.
It searches for configuration files from your current directory up to the root directory with one of the following names:

- `.vmpirc.json`
- `.vmpirc.yaml`
- `.vmpirc.yml`

### Example `.vmpirc.json`

```json
{
  "memory": 512,
  "cpus": 2,
  "network": {
    "providers": ["github-copilot", "anthropic"],
    "allowedDomains": ["my-custom-llm.example.com"],
    "localServices": [{ "hostname": "ollama.local", "port": 11434 }]
  }
}
```

### Options

| Key | Default | Description |
|---|---|---|
| `memory` | `512` | RAM in MiB |
| `cpus` | `1` | vCPU count |
| `piConfigDir` | `~/.pi` | Path to the pi config directory on the host |
| `stateDir` | `~/.vmpi` | Where vmpi stores the base checkpoint and tarball cache |
| `network.policy` | inferred | `"allow-all"`, `"deny-all"`, or `"custom"`. Auto-set to `"custom"` when providers/domains are configured |
| `network.providers` | `[]` | LLM provider names to allow (see below) |
| `network.allowedDomains` | `[]` | Additional external domain patterns to allow |
| `network.localServices` | `[]` | Host services to expose inside the VM. Each entry is `{ hostname, port }`. The VM can reach `hostname` at the given host `port` via a raw TCP tunnel. |
| `rootfsExtraMb` | `128` | MiB to add to the Gondolin rootfs image during `vmpi setup` when free space is below this threshold. Increase this if setup fails with a disk-full error. |

Environment variables (`VMPI_MEMORY`, `VMPI_CPUS`, `PI_CONFIG_DIR`, `VMPI_STATE_DIR`, `VMPI_ROOTFS_EXTRA_MB`) override their config file equivalents.

### Built-in providers

| Provider | Allowed domains | Source |
|---|---|---|
| `github-copilot` | `*.githubcopilot.com`, `api.github.com`, `copilot-proxy.githubusercontent.com` | [docs.github.com/en/copilot/reference/copilot-allowlist-reference](https://docs.github.com/en/copilot/reference/copilot-allowlist-reference) |
| `gemini` | `generativelanguage.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com` | [ai.google.dev/gemini-api/docs/quickstart](https://ai.google.dev/gemini-api/docs/quickstart) |
| `openai` | `api.openai.com` | [platform.openai.com/docs/api-reference](https://platform.openai.com/docs/api-reference/introduction) |
| `anthropic` | `api.anthropic.com` | [docs.anthropic.com/en/api/getting-started](https://docs.anthropic.com/en/api/getting-started) |
| `ollama` | `localhost`, `127.0.0.1` | (local service, no external network) |

Multiple providers can be combined. Their domains are merged with any `allowedDomains`.

## How it works

Gondolin manages QEMU microVMs with a JavaScript-implemented network stack and VFS.
`vmpi setup` builds a **base checkpoint** by installing pi into a fresh VM and saving
a qcow2 disk snapshot. Each `vmpi` run resumes from that checkpoint in ~1 s, then
mounts the workspace and `~/.pi` via VFS providers (`RealFSProvider`).

The pi tarball is downloaded on the host (not inside the VM) because Gondolin's
MITM proxy does not reliably handle large concurrent streaming downloads. The
tarball is transferred into the VM via `vm.fs.writeFile()` which uses the
virtio-serial control channel, a separate path from the network proxy that
correctly handles large files.

Network policy is enforced via `createHttpHooks`, which intercepts all HTTP/TLS
egress and blocks requests to unlisted hosts.

### Session continuity

Pi stores sessions under `~/.pi/agent/sessions/` named after the project path.
Because the project is always mounted at `/workspace` inside the VM, vmpi translates
session directories on both sides:

- **Before launch:** a symlink `~/.pi/agent/sessions/--workspace--` to host CWD session
  dir is created so pi finds prior sessions. Writes go directly to the host filesystem
  via the VFS mount.
- **After exit:** the symlink is removed. Any Pi sessions written directly to the
  `--workspace--` slot are merged back into the host CWD session dir.

### Why no root required

Gondolin's QEMU backend runs entirely in userspace; no TAP devices, no nftables
rules, no setuid jailer. `vmpi` runs as your normal user as long as `/dev/kvm`
is group-readable (the default on most Linux distros with KVM enabled).

### Machine type workaround

On Linux x86_64, Gondolin selects `microvm` as the QEMU machine type, but
generates `-device virtio-*-pci` arguments that require a PCI bus. `microvm`
has no PCI bus, so QEMU crashes immediately. vmpi forces `q35` (a modern PCIe
chipset) via `sandbox: { machineType: 'q35' }` as a workaround.

## Limitations

- **Linux x86_64 only:** macOS and aarch64 are untested. The `q35` machine type
  workaround is specific to Linux x86_64; other platforms may need adjustments.
- **First run is slow:** `vmpi setup` downloads the Gondolin guest image (~300 MB),
  downloads the pi tarball (~4 MB), and runs `npm install` inside the VM (~60s total).
  Subsequent runs resume from the checkpoint in ~1 s.
- **Rootfs free space:** Gondolin's Alpine rootfs image has limited free space (~79 MiB). `vmpi setup` automatically grows the image by `rootfsExtraMb` MiB (default: 128) using `qemu-img resize` + `e2fsck` + `resize2fs` whenever free space is below that threshold. This requires `e2fsprogs` (`sudo apt install e2fsprogs` / `sudo pacman -S e2fsprogs`). If setup still fails with a disk-full error, increase `rootfsExtraMb` in your `.vmpirc.json` or via `VMPI_ROOTFS_EXTRA_MB`.
- **Session directory is tmpfs:** `/root`, `/tmp`, and `/var/log` are tmpfs-backed in
  the guest. Sessions under `/root/.pi` are visible on the host via the VFS mount and
  are not lost when the VM closes.
