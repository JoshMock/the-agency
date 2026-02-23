This is my coding agent harness. There are many like it, but this one is mine.

Runs [oh-my-pi](https://github.com/can1357/oh-my-pi), a sane (as in, not OpenClaw) but batteries-included fork of the [Pi coding agent](https://github.com/badlogic/pi-mono), in a container.

## Usage

Requires [just](https://just.systems/) and [podman-compose](https://github.com/containers/podman-compose). Then run `just start` to turn it on, or `just restart` to turn it off and back on again.

## Goals

### Local inference

Privacy, self-sufficiency and energy conservation are personal values of mine, so this should be capable of running without access to any cloud services.

[vLLM](https://docs.vllm.ai) runs when I'm on a laptop that has an Nvidia GPU with [Nvidia Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/) installed, so that inference can be done locally. This is still very experimental, so it is still able to connect to popular coding inference services.

[docs-mcp-server](https://github.com/arabold/docs-mcp-server) is also running, and keeps a local cache of machine-readable documentation for several libraries and tools I use often.

### Security

This runs in a container so that it can only modify files I mount to it, and only run executables that I've explicitly installed. It also uses [pi-guardrails](https://www.npmjs.com/package/@aliou/pi-guardrails) to gate its ability to run bash commands without my permission.

### Ethics

Ethical concerns about plagiarism is a common issue people have with how LLMs are trained. By providing the opportunity to do local inference, I'm able to explore the massive ecosystem of models available on HuggingFace and elsewhere, many of which have been trained on a more carefully curated set of data to avoid these concerns.

## Plans

I should probably put these in Github issues.

Goals are **not** about making agents DO MORE, more about ensuring agents are ethical, economical and secure.

- an extension to integrate with [ACE](https://github.com/kayba-ai/agentic-context-engine) so that agents can perform self-learning while they work
- experimentation with agent memory tools like [Beads](https://github.com/steveyegge/beads)
- better agent search tooling with [qmd](https://github.com/tobi/qmd), Elasticsearch, etc
- use [LLM Compressor](https://github.com/vllm-project/llm-compressor) to improve the speed and energy usage of local inference
- use [tokenshrink](https://github.com/chatde/tokenshrink) to reduce token usage, also to improve speed and energy usage
- experimentation with [nono](https://docs.nono.sh) for zero-trust: more security, an audit chain of provenance, atomic rollback, etc.
