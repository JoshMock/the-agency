A collection of extensions, skills, tools and experiments with the [Pi coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

## Current offerings

- [**@the-agency/pi-tokenshrink**](./packages/tokenshrink/): reduce a prompt's token count deterministically, without using inference
- [**@the-agency/pi-hashline-edit**](./packages/hashline-edit/): alternate to Pi's built in `edit` tool that improves the accuracy and efficiency of file edits, with high potential to reduce token usage
- [**@the-agency/pi-spec-kit**](./packages/spec-kit/): use [Spec Kit](https://github.com/github/spec-kit) for spec-driven development
- [**@the-agency/vmpi**](./packages/vmpi/): run `pi` sandboxed in a QEMU microVM via [Gondolin](https://earendil-works.github.io/gondolin/) -- hardware-isolated, no root required
- [**@the-agency/pi-observability**](./packages/observability/): record OpenTelemetry logs for your Pi sessions

## Goals

### Local inference

**Privacy**, **self-sufficiency**, **ethics** and **energy conservation** are personal values of mine, so there will be an emphasis on local and low-energy inference sources (e.g. [vLLM](https://docs.vllm.ai/) using local GPUs or CPUs).

Local inference also enables experimentation with open models that have been trained on more carefully curated sets of data.

### Security

  See [vmpi](./packages/vmpi/). [pi-guardrails](https://www.npmjs.com/package/@aliou/pi-guardrails) is a handy UX improvement, but it's not a security feature. Even running in a Docker container or a process-level sandbox is not bulletproof. If you're installing packages from npm, *especially* if they're developed with agent assistance, all that code should be isolated from the rest of your system. Running your agent&mdash;and its extensions, tools and skills&mdash;in a virtual machine is the safest way to protect your machine from errant agent choices and supply-chain attacks.

### Do less, better

Avoid maximalism and accelerationism vibes. All code output is authored by a human&mdash;assisted by an agent, but with thorough review and revision&mdash;who understands, dog-foods and ultimately vouches for all code before publishing it for others. These are tools to help developers craft a coding agent experience to help them, not replace them. It is **not** intended to enable [inactive gods](https://en.wikipedia.org/wiki/Deus_otiosus) wishing to set a course and walk away.

Doing less also means:

- optimizing prompts for token efficiency
- limiting what agents can see and do to avoid context bloat and incorrect choices

Doing better also means:

- navigating code lexically: why grep when you can query a syntax tree?
- optimizing prompts for accuracy, preventing agents from doing the wrong thing
- measure performance where possible to find bottlenecks
