# Verification: a cloud token can be minted with nothing installed

Date: 2026-08-01
Status: **run**, for everything that can be run without a cloud account. No Cloud
Reach has ever existed, so the part that matters most is still unmeasured — see
"What this does not settle".

Measured on: this session's sandbox, on Node 22. Not a roma deployment, and not
an image-layer measurement — no Docker daemon was available.

Extracted from ADR-0015's `Verification status` on 2026-08-02. The measurements
and their prose are unchanged; what moved is where they live. ADR-0015 keeps the
findings that bear on its decision and links here for the evidence, in the shape
ADR-0011 uses.

## Measured — what a cloud CLI costs

Google Cloud CLI 578.0.0, `linux x86_64`, downloaded and unpacked in this
session:

```
google-cloud-cli-linux-x86_64.tar.gz    88,566,196 bytes  (compressed)
unpacked                               460,335,231 bytes  (439 MiB)
```

Against a runtime stage that is `node:22-slim` plus five apt packages and one Go
binary. This is on-disk footprint rather than an image layer; a layer would be of
the same order.

## Measured — the image can already do all of it, with nothing installed

On Node 22, using only `node:crypto`, with no dependency whatsoever:

- an RS256-signed JWT, which is exactly what a Google service account key is
  exchanged with;
- the SigV4 HMAC-SHA256 key derivation chain, which is what AWS requires;
- global `fetch` is present, so not even `curl` is needed.

## Measured — the token endpoints answer a credential-shaped request

One POST each from this session's sandbox, with deliberately invalid
credentials:

| endpoint | answered |
| --- | --- |
| `oauth2.googleapis.com/token` | `invalid_request` |
| `login.microsoftonline.com/…/oauth2/v2.0/token` | `AADSTS700016: Application with identifier 'bogus' was not found` |
| `sts.amazonaws.com` | `MissingAuthenticationToken` |

Each rejected the *credential* rather than the request: a valid one would have
been exchanged. Azure's is a plain POST with no signing at all.

## Measured — scopes are a property of the exchange, not an invention

Read out of the installed `google-auth-library`: `scopes` is optional on the JWT
client, and the client takes one of two paths — a self-signed JWT bound to a
target audience when no scopes are set, or an access-token exchange when they
are. With neither scopes nor an audience it returns empty headers. So a
general-purpose access token requires naming scopes, and the only way to avoid
naming them is to bind the credential to one API up front.

## What this does not settle

**What the endpoint measurement is not.** It was taken from this session's
sandbox and not from a roma deployment, so it establishes the protocol shape and
not any particular deployment's egress. The README states that roma has no egress
allowlist and no firewall, which is the only reason the shape is the whole story.

**Not measured.** The cost of a mint against a real service account, expected to
be sub-second and free. How usable narrow scopes are across Google's APIs. And
everything else: no part of this has been deployed, and no Cloud Reach has ever
existed.
