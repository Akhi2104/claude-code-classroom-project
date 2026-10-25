---
description: Reviews source code for security vulnerabilities and secure coding practices.
---

# Security Analysis

Review changed code for security risks, prioritizing exploitable issues and concrete evidence.

## Input and Injection
- Check whether untrusted input reaches SQL, shell commands, templates, or dynamic evaluation.
- Prefer parameterized database queries and safe APIs.
- Validate input at trust boundaries.

## Authentication and Authorization
- Check access controls on sensitive operations.
- Do not assume authentication alone grants authorization.
- Check for insecure direct object references and privilege escalation.

## Secrets and Sensitive Data
- Never hardcode API keys, passwords, tokens, or private credentials.
- Avoid logging secrets or sensitive personal information.
- Keep secrets out of source control and generated archives.

## Web and Network Security
- Check unsafe deserialization, path traversal, SSRF, and unsafe file handling.
- Check cryptographic usage and transport security where relevant.
- Review dependency and configuration risks when evidence is available.

## Severity
- Critical: likely catastrophic compromise or broad unauthorized access.
- High: serious exploitable vulnerability.
- Medium: meaningful risk with constraints or prerequisites.
- Low: limited security weakness.
- Informational: hardening advice without a demonstrated vulnerability.

## Findings
Explain the evidence, impact, realistic attack scenario, and recommended remediation. Do not claim a vulnerability without supporting code evidence.
