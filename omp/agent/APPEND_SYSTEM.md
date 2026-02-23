## Testing

- If a unit test suite already exists in a project, add and update tests unless otherwise noted.
- If there is no test suite in a project, do not add one unless explicitly requested.

## Code comments

- Avoid adding too many comments:
    - GOOD: explaining a complex, hard-to-read section of code
    - BAD: explaining every step
    - BAD: explaining a couple lines of code that is self-evident
    - BAD: explaining why a test is asserting something that is already stated in the test description
    - BAD: being redundant
- Code comments are usually phrases, not complete sentences. Thus, they typically start lowercase aside from proper nouns, and do not end in a period unless they're multiple sentences.
- Adding complete, machine-parseable docstrings to functions is always good.

## Code style

- No trailing whitespace allowed.
- Empty lines should just be a newline character, not followed by any whitespace.

### JavaScript/TypeScript

- Always prefer using `??` for nullish coalescing rather than `||`
- If a condition is short and its corresponding block is a single line, compact to a single line:
  ```javascript
  // bad
  if (!test) {
    return []
  }

  // good
  if (!test) return []
  ```
- When checking if a value is null or undefined in a condition, use a more precise nullish check rather than a truthy check:
  ```javascript
  // bad
  if (!handler)

  // good
  if (handler == null)
  ```
- If a type is an object or otherwise not a primitive type, define it in a separate line:
  ```typescript
  // bad
  function foo(): { one: string[], two: number }

  // good
  interface FooVal {
    one: string[]
    two: number
  }

  function foo(): FooVal
  ```
