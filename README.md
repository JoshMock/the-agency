A collection of extensions, skills, tools and experiments with the [Pi coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

## Current offerings

- [**pi-tokenshrink**](./packages/tokenshrink/): reduce a prompt's token count deterministically, without using inference
- [**pi-hashline-edit**](./packages/hashline-edit/): alternate to Pi's built in `edit` tool that improves the accuracy and efficiency of file edits, with high potential to reduce token usage
- [**pi-spec-kit**](./packages/spec-kit/): use [Spec Kit](https://github.com/github/spec-kit) for spec-driven development
- [**vmpi**](./packages/vmpi/): run `pi` sandboxed in a QEMU microVM via [Gondolin](https://earendil-works.github.io/gondolin/) -- hardware-isolated, no root required

## Goals

### Local inference

**Privacy**, **self-sufficiency**, **ethics** and **energy conservation** are personal values of mine, so there will be an emphasis on local and low-energy inference sources (e.g. [vLLM](https://docs.vllm.ai/) using local GPUs or CPUs).

Local inference also enables experimentation with open models that have been trained on more carefully curated sets of data.

### Security

Tools and experiments will ideally build on the use of containers or other tools (e.g. [nono](https://nono.sh/)) that limit the blast radius of an agent. [pi-guardrails](https://www.npmjs.com/package/@aliou/pi-guardrails) is a great start, but there are many ways to work around it.

### Do less, better

Avoid maximalism and accelerationism vibes. All code output is authored by a human&mdash;assisted by an agent, but with thorough review and revision&mdash;who understands, dog-foods and ultimately vouches for all code before publishing it for others. These are tools to help developers craft a coding agent experience to help them, not replace them. It is **not** intended to enable [inactive gods](https://en.wikipedia.org/wiki/Deus_otiosus) wishing to set a course and walk away.

Doing less also means:

- optimizing prompts for token efficiency
- limiting what agents can see and do to avoid context bloat and incorrect choices

Doing better also means:

- navigating code lexically: why grep when you can query a syntax tree?
- optimizing prompts for accuracy, preventing agents from doing the wrong thing
- measure performance where possible to find bottlenecks
