---
description: Reviews Python code for correctness, idiomatic usage, maintainability, and common defects.
---

# Python Code Review

## Correctness
- Check edge cases, exception handling, resource cleanup, and mutation.
- Check for incorrect assumptions about empty values, types, and collection contents.
- Verify asynchronous code uses appropriate async APIs.

## Python Practices
- Use context managers for files, locks, and other managed resources.
- Prefer clear comprehensions and small functions over unnecessarily complex logic.
- Use type hints where they clarify contracts.
- Avoid mutable default arguments.
- Use standard-library functionality where it is simpler and safer.

## Reliability and Performance
- Check repeated expensive operations and avoid unnecessary work.
- Check iterator consumption and memory use for large collections.
- Validate external data and handle expected failures.

## Findings
Give actionable findings with evidence, severity, impact, and a practical fix. Avoid stylistic nitpicks unless they materially affect readability or maintenance.
