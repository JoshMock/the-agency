# pi-tokenshrink

A [Pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) extension that uses [tokenshrink](https://tokenshrink.com/) to reduce token count of a prompt in a deterministic way that does not depend on LLM-based inference.

## Install

```sh
pi install npm:@the-agency/pi-tokenshrink
```

## Usage

Token reduction will be turned on automatically, and its status, plus an estimated count of saved tokens, will appear in the Pi status bar.

Commands:

- `/tokenshrink on`: enable
- `/tokenshrink off`: disable
- `/tokenshrink toggle`: toggle between on and off
