## Development workflow

Requirements for all code changes:

- use red/green TDD as the internal development methodology; pausing for approval of tests before implementation is not required
- update README and other relevant docs for completeness when any package receives new functionality or other notable changes
- all functions, classes and properties need docstrings

## Source control

- If writing a commit/revision message, use conventional commit format, but do not include the name of the package in parens.Example: if fixing a bug in vmpi, just do `fix: <description>`, not `fix(vmpi): description`
