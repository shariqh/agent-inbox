# Agent profile extension, version 1

**URI:** `https://shariqh.github.io/agent-inbox/ext/profile/v1`

**Status:** version 1. A change that a version 1 reader would misread gets a new URI (`/v2`), as
A2A v1.0.1 §4.6.3 asks; this document only gains clarifications.

**Defined by:** [agent-inbox](https://github.com/shariqh/agent-inbox), in its
[publishable-agent design](https://github.com/shariqh/agent-inbox/blob/main/docs/superpowers/specs/2026-11-10-publishable-agent-design.md)
(§3.4 and §3.7 to §3.10).

## What it is for

An A2A v1.0.1 agent card has no field for four things someone needs before they add an agent
they did not write: a stable id that survives a move to another host or port, the keys that sign
the card, what each skill contacts with the caller's input, and where each skill may run. This
extension carries all four, in one place, inside the card. Because extension params are part of
the card, they are covered by the card's signature (A2A §8.4) and by any pin a client keeps of
the card, so a change to any of them is a card change.

Everything here is a **declaration** by the publisher. A client shows it to the human as a claim;
it does not enforce it.

## Declaring it

The extension goes in the card's `capabilities.extensions`:

```json
{
  "uri": "https://shariqh.github.io/agent-inbox/ext/profile/v1",
  "description": "Stable id, signing keys, and per-skill egress and residency",
  "params": {
    "id": "shariqh.github.io/agent-inbox/web-search",
    "keys": [
      { "kty": "EC", "crv": "P-256", "x": "<base64url>", "y": "<base64url>" }
    ],
    "skills": {
      "web-search": {
        "egress": [
          { "purpose": "search", "hosts": "operator", "sends": "input" },
          { "purpose": "model", "hosts": "operator", "sends": "input" }
        ],
        "residency": "caller-mesh"
      }
    }
  }
}
```

- Omit `required`. Do not write `"required": false`: it is the protobuf default, which A2A
  signers drop before signing (see "No empty or default values").
- A client that does not know this extension can still call the agent.
- A card carries this extension at most once.

## The params

`params` is an object with these members and no others.

| Member | Required | Value |
|---|---|---|
| `id` | yes | The agent's stable id (below). |
| `keys` | no | 1 to 4 public keys that sign the card (below). |
| `skills` | no | One entry per skill of the card (below). |

The extension marks only `id` as required. A client may require more before it accepts a card
from someone else: agent-inbox's publishable level requires `keys` with a valid signature, and
`egress` and `residency` for every skill.

### id

The publisher's stable name for the agent: the same string at every endpoint the agent ever has.

```text
<domain>[/<segment>…]/<name>
```

- `<domain>` is a lower-case DNS name with at least one dot, written in punycode for an
  internationalised name: labels of 1 to 63 characters of `a-z`, `0-9` and inner `-`, at most
  253 characters, and a last label that is not all digits (so never an IP address).
- Each `<segment>` and the `<name>` are one or more characters of `a-z`, `0-9` and `-`. The name
  is at most 40 characters.
- The whole id is at most 200 characters.
- No scheme, user, port, query or fragment: the character set leaves no room for them.

Examples: `shariqh.github.io/agent-inbox/web-search`, `example.org/notes-search`.

The id is a claim, not proof: anyone can write any domain. The pair of the id and a key that
signs the card is what a client remembers. The id is not a tenant or namespace of whoever runs
the agent.

**Mapping to ARD and AI Catalog.** Replace every `/` with `:` and prefix `urn:air:`:
`shariqh.github.io/agent-inbox/web-search` becomes
`urn:air:shariqh.github.io:agent-inbox:web-search`. The mapping is one way and used only when
exporting to those formats.

### keys

The public keys that sign this card, as RFC 7517 JSON Web Keys, each with exactly these members
and nothing else:

| Curve | Members | Coordinate length (base64url, no padding) |
|---|---|---|
| P-256 | `kty: "EC"`, `crv: "P-256"`, `x`, `y` | 43 characters each |
| P-384 | `kty: "EC"`, `crv: "P-384"`, `x`, `y` | 64 characters each |
| Ed25519 | `kty: "OKP"`, `crv: "Ed25519"`, `x` | 43 characters |

- At least 1 and at most 4 keys, none listed twice.
- No private member (`d` or any other): a card listing one is refused.
- No `kid`, `use`, `alg` or other member. A key's id is its RFC 7638 thumbprint, computed from
  the members above, never written.
- A new key, a removed key or a changed key is a card change.

Listing the keys themselves, not only their thumbprints, lets a standard A2A verifier find the
key a signature names: it looks the signature's `kid` up in this list.

### skills

An object with one member per skill of the card, named by the skill's `id`: exactly the card's
skill ids, no more and no fewer. Each value is an object with these members and no others:

| Member | Value |
|---|---|
| `egress` | What the skill contacts while it works: the string `"none"`, or a list of 1 to 8 entries. |
| `residency` | Where a router may place the skill's work: `caller-host`, `caller-mesh` or `any`. |

#### egress

Each entry is an object with exactly these members:

| Member | Values | Meaning |
|---|---|---|
| `purpose` | `model`, `search`, `storage`, `web`, `api`, `agent` | What kind of service. `agent` means it calls another agent. A closed list in version 1. |
| `hosts` | A list of 1 to 8 lower-case DNS names in punycode (a leading `*.` allowed), or `"operator"`, or `"any"` | Named hosts are fixed in the agent's code. `"operator"`: a host whoever runs this copy configures, not named in the card. `"any"`: hosts a request or a result names (a page fetcher). |
| `sends` | `input`, `metadata` | `input`: the caller's text, whole or in part. `metadata`: identifiers and parameters only, never the text. |

`"none"` means the skill contacts nothing. It is a string, not an empty list.

`"operator"` exists because a card is public: naming a private model or search host would
publish that name, and two copies of one agent with different backends serve the same card.

#### residency

| Value | Meaning |
|---|---|
| `caller-host` | Only a copy on the caller's own host. |
| `caller-mesh` | A copy on any host in the caller's mesh. |
| `any` | Any copy, including one someone else runs. |

An agent added from a public name is outside the caller's mesh, so only `any` can be satisfied
for it.

## No empty or default values

No member of `params`, at any depth, is an empty string, an empty list, an empty object or
`null`. A2A signers strip such values before signing (the A2A JS SDK strips all of them,
recursively), so a verifier using such a signer would not notice them change. A card that breaks
this rule is refused.

## Signatures

The card is signed as A2A v1.0.1 §8.4 says: a JWS (RFC 7515) in the card's `signatures` list,
each entry `{ "protected", "signature" }`, over the RFC 8785 (JCS) form of the card without
`signatures`.

- **Algorithms:** `ES256` (P-256), `ES384` (P-384) or `EdDSA` (Ed25519). Never `none`, an `HS*`
  algorithm or an RSA algorithm.
- **Protected header:** `alg`, `typ: "JOSE"` and `kid`, the RFC 7638 thumbprint of one of the
  listed `keys`. A header holding `crit`, `b64` or `x5c` is refused. A `jwk`, `jku` or `x5u`
  member is ignored and never fetched: the key comes from the signed list.
- **Payload:** the raw JCS form of the card as served, without `signatures`, with no other
  normalisation. A signature that does not verify over it does not count.
- **Signers** sign only cards with no empty string, list or object, no `null` and no
  default-valued field (in practice `"required": false` on an extension). For such a card, raw
  JCS, A2A §8.4.1's rule and the A2A JS SDK sign the same bytes, so every verifier agrees.
- **Copies on other hosts** each sign their own card with their own key, listed here; no private
  key is copied between hosts.
- **Rotation:** list the new key beside the old one and sign with both; drop the old key after at
  least 30 days.
- A card with `signatures` but no `keys`, or whose signatures name no listed key, counts as
  unsigned.

## Limits

| What | Limit |
|---|---|
| The whole card | 64 KiB, nested at most 32 levels |
| `id` | 200 characters; `<name>` 40 |
| `keys` | 4 |
| `egress` entries per skill | 8 |
| `hosts` per egress entry | 8 |
| Signatures per card | 4, each protected header at most 2 KiB decoded |

## Reading it

A client that speaks this extension refuses a card whose profile breaks any rule above, with a
fixed reason that never quotes the card. A member this document does not define is a break, not
something to skip: a later version defines new members under a new URI.
