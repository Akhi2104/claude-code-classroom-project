---
description: Reviews TypeScript code for type safety, maintainability, and robust patterns.
---

# TypeScript Patterns

Review TypeScript code for correctness, type safety, and maintainability.

## Type Safety
- Avoid `any` when a more precise type or `unknown` is appropriate.
- Narrow `unknown` values before accessing properties.
- Handle `undefined` and `null` explicitly.
- Use discriminated unions for related states and exhaustive checks where useful.
- Avoid unsafe type assertions that hide errors.

## Functions and Data
- Define clear parameter and return types for public APIs.
- Use generics when they improve type safety and reuse.
- Prefer immutable data where practical.
- Validate external input at runtime; TypeScript types do not validate network data.
- Handle rejected promises and asynchronous errors.

## Maintainability
- Prefer small functions with clear responsibilities.
- Avoid duplicated logic and unnecessary complexity.
- Use `strict` compiler settings where practical.
- Check boundary conditions and empty collections.

## Findings
Report only actionable issues supported by the code. Include file, line when available, severity, impact, and a suggested fix. Do not invent line numbers or findings.
