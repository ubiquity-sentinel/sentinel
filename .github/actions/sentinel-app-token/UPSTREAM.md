# Sentinel App token action

Derived from
[actions/create-github-app-token](https://github.com/actions/create-github-app-token)
commit `bcd2ba49218906704ab6c1aa796996da409d3eb1` (v3.2.0), under the retained
MIT license. The upstream package.json and package-lock.json are retained
byte-for-byte. The unbundled main/post sources use the same locked production
dependencies and the GitHub runner's Node24 action runtime (upstream requires
Node >=24.4.0).

Before use, in a separate credential-free setup step, run:

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix .github/actions/sentinel-app-token
```

Tests require the same preparation plus Node24 >=24.4.0. Tests remain offline;
missing dependencies are a setup failure, never an automatic skip or fetch.

Sentinel's adaptation adds bounded, explicitly selected nonsecret metadata from
the same successful mint response. Metadata is inert input to later trusted host
validation, never standalone principal authority. It preserves the original
token output, inherited permissions when permission inputs are unset, and native
post-action token revocation. The private key stays in the mint action. No
token, private key, header, authentication object, or response spread belongs in
the metadata output.

The action is dormant until a reviewed workflow explicitly selects this local
path from its clean protected launcher checkout. No workflow or runtime policy
is activated by adding these files.

A second adaptation (`lib/tolerant-mint.js`) is selected only by the explicit
`tolerate-inaccessible-repositories: "true"` input of a repository mint. The
upstream request pair runs first and is unchanged for a reachable list. Only
GitHub's refusal of the list as not accessible to the installation (or a
first-name installation lookup that is missing or belongs to another account;
lookups never follow a redirect) starts a bounded bisection by revoked probe
mints for subsets of the same list with the same permissions, against the
requested owner's own installation. The token then covers exactly the reachable
names, never more (a token naming anything else is revoked and fails), and
`unavailable-repositories` plus one warning line name the dropped ones. An
optional `known-unavailable` hint (an earlier job's output) only removes listed
names up front. No reachable name, more than three dropped names or more than a
quarter of the list, or a spent probe bound still fails the mint.

Upstream source formatting follows the repository formatter. Entry functions use
explicit await for the existing asynchronous operation. Credential-consumer
failure, retry and revocation diagnostics use static messages without exception
objects or response text; exit, retry and cleanup behavior remains unchanged.
