# pi-hashline-edit

A [Pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) extension, to substitute for the built-in `edit` tool, which uses a hashline-based file editing strategy to improve the accuracy and efficiency of agents' file-editing abilities, reducing the likelihood of failed edits that require extra turns and tokens by the agent.

This editing strategy has improved the edit success rate of Gemini models by 8%, Claude Sonnet 4.5 by 14.4%, etc. and reduced overall token usage, **without requiring any additional training to these models**.

Heavily inspired by/borrowed from Can Bölük's [oh-my-pi](https://github.com/can1357/oh-my-pi) fork of Pi. I've simply extracted hashline editing from `omp` into a standalone extension, with some adjustments to ensure it can run in both Node and Bun. See Can's blog post, [I Improved 15 LLMs at Coding in One Afternoon. Only the Harness Changed](https://blog.can.ac/2026/02/12/the-harness-problem/) to understand how it works and how well it improves coding agent editing accuracy.

## Install

```sh
pi install npm:@the-agency/pi-hashline-edit
```

This will enable the `hashline_read` and `hashline_edit` tools, and disable the built-in `edit` tool, to ensure models are not confused about which editing tool to use.
