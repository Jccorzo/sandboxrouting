# Security

sandboxrouting holds API keys for many providers and runs code in their sandboxes, so a flaw
in it can expose keys or let one sandbox's caller reach another's. Please report one
privately.

## Reporting

Use GitHub's private vulnerability reporting: the **Security** tab of this repository, then
**Report a vulnerability**. Don't open a public issue. Include what an attacker can do, the
version or commit, and the steps to reproduce it.

You'll get an answer within a week. Fixes go into the latest release; there are no
long-term support branches.

## Scope

In scope: the router, the REST server (`sbr serve`), the MCP server, the CLI and the
provider adapters in this repository. For example: keys leaking into logs, ledger files or
error messages; `sbr serve` answering without its token; a sandbox reached through another
caller's id.

Out of scope: weaknesses of a provider's own sandbox isolation (report them to that
provider), and setups that expose `sbr serve` without `serverToken` on purpose.
