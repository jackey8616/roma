# infra

The Pub/Sub ingress and roma's identity, as Terraform somebody runs by hand.

roma provisions nothing. The topic Google Chat publishes to, the subscription roma pulls
from, the service account it runs as and the two grants that make either work all exist
before roma starts — `src/channels/google-chat/env-config.ts` only names them. This
directory is the other half of that boundary: infrastructure-as-code a person applies, not
the application reaching for the API at runtime. `src/channels/google-chat/provisioning.test.ts`
is what keeps those two halves apart.

## What it makes

| | |
| --- | --- |
| `roma-chat-events` | the topic Chat publishes interaction events to |
| `roma-chat-events-sub` | the subscription roma pulls from — `ROMA_PUBSUB_SUBSCRIPTION` |
| `roma-runtime@…` | the service account roma runs as — **renamed from `roma-agent`**, see below |
| `roma-chat-events-dead-letter` (+ a subscription on it) | where a message nobody could answer is set aside |
| two grants | `chat-api-push@system.gserviceaccount.com` may publish to the topic; roma may subscribe |
| two more grants | Pub/Sub's own service agent may move a message to the dead-letter topic |
| four APIs | Pub/Sub, IAM, Cloud Resource Manager and Chat, enabled — and left enabled on `terraform destroy` |

Names are variables — see `variables.tf`, and `terraform.tfvars.example` for the shape of
an override.

## What it does not make

- **The Chat app itself.** That is a console form on a Workspace, not a Terraform resource.
  The steps are below, in the order they have to happen.
- **A service account key.** A `google_service_account_key` resource writes the private key
  into Terraform state in plaintext, which turns the state file into a credential. Minting
  one is below too.
- **The agent's Cloud Reach.** The identity the *agent* acts as in Google Cloud is not made
  here and should not live in this project at all. The manual steps are below.
- **Anything that runs roma** — no container, no VM, no firewall, and **no egress
  allowlist**. ADR-0003 describes that allowlist as the only protection still doing real
  work under `bypassPermissions`; roma does not have it and neither does this. A template
  that provisioned the queue and stopped could easily read as "the infrastructure is done".
  It is not.

## Applying it

You need a Google Cloud project with billing enabled, Terraform ≥ 1.5, and credentials that
can administer Pub/Sub, IAM and service usage in that project — `roles/owner` is the easy
answer, `roles/pubsub.admin` + `roles/iam.serviceAccountAdmin` +
`roles/serviceusage.serviceUsageAdmin` the narrow one.

```bash
gcloud auth application-default login
cd infra
terraform init
terraform apply -var project_id=YOUR_PROJECT
```

Then export what it printed:

```bash
eval "$(terraform output -raw roma_environment)"
```

That is `ROMA_PUBSUB_PROJECT_ID` and `ROMA_PUBSUB_SUBSCRIPTION`, spelled exactly as
`README.md`'s environment table asks for them. There is nothing to translate by hand, which
is the point.

Into the shell rather than into a file, because roma reads the process environment and
nothing loads a `.env` for it — the `.env` at the repo root is the seam 2 tests' and theirs
alone. Whatever actually starts roma is what has to carry these two.

**Re-applying an unchanged configuration is a no-op** — `terraform plan` says "No changes"
and it is the cheapest way to check that nothing has drifted since.

> On a brand-new project the first apply can still fail on the two dead-letter grants.
> Enabling the Pub/Sub API is what creates Google's own service agent, and IAM is
> occasionally slower to see it than Terraform is to bind it. Run `terraform apply` again;
> everything here is idempotent, so a second apply either finishes the job or says there is
> nothing to do.
>
> The provider has a resource for exactly this — `google_project_service_identity`, which
> creates the agent rather than waiting for it — and it is `google-beta` only, checked
> against the schema of `hashicorp/google` v7.42. Dodging an occasional second apply is not
> worth a second provider in the lock file, so the retry is documented instead of designed
> away.

## The Chat-side steps, in the order they have to happen

Terraform can do none of this. The order matters in one place and it is called out.

1. **Apply the Terraform first.** The Chat app's configuration form validates the topic when
   you paste it, and the check it runs is whether `chat-api-push@system.gserviceaccount.com`
   holds `roles/pubsub.publisher` on it. Without that grant the form refuses the topic, and
   the refusal reads as a problem with Chat rather than as a missing IAM binding. This is the
   step that is worth doing in order rather than doubling back to.

2. **Open the Google Chat API's configuration** in the same project you just applied into —
   the Cloud console, *APIs & Services* → *Google Chat API* → *Configuration*. Terraform has
   already enabled the API, so the page is reachable. The topic must live in this project;
   Chat will not publish to one in another.

3. **Fill in the app's identity** — name, avatar URL, description. Cosmetic, and required
   before the form will save.

4. **Turn on the functionality roma needs**: receive 1:1 messages, and join spaces and group
   conversations. ADR-0004 keys a Conversation on the thread in a space and on the space
   itself in a DM, so roma is built for both.

5. **Set the connection to Cloud Pub/Sub** and paste the topic:

   ```bash
   terraform output -raw chat_events_topic
   ```

   Not an HTTPS endpoint. ADR-0004 rejected the webhook: it would need an inbound port and
   would impose the ~30-second response deadline that a minutes-long Turn cannot meet.

6. **Choose who can install it**, and save.

7. **Install the app** and add it to a space, or message it directly. An app's authority in a
   space comes from being installed there — there is no IAM role for the outbound side, which
   is why the Terraform grants none.

The current field-by-field reference is
[Google's Chat API configuration docs](https://developers.google.com/workspace/chat/configure-chat-api);
the console's wording moves around and the names above are what to look for, not a click path.

## roma's credential

roma resolves Application Default Credentials, so there are two ways and roma cannot tell
them apart:

- **On a Google host** — attach the service account to the instance and set
  `GOOGLE_APPLICATION_CREDENTIALS` to nothing at all. The metadata server answers. Prefer
  this; it is the option with no key to leak.
- **Anywhere else** — mint a key by hand and point at it:

  ```bash
  gcloud iam service-accounts keys create roma.json \
    --iam-account="$(terraform output -raw roma_service_account_email)"
  export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/roma.json
  ```

  The file is a credential. It is not in this repo's `.gitignore` by name because it should
  not be in this repo at all.

### The account was renamed, and an existing deployment has to choose

`service_account_id` used to default to `roma-agent` and now defaults to `roma-runtime`. In
roma's vocabulary the **agent** is the Claude Code process, and this account is precisely the
one the agent must never be able to act as — so the old name was an invitation to bind the
agent's Google Cloud access to the identity roma's own ingress depends on (ADR-0015 §2).

**A Google Cloud account id is immutable**, so changing it is a destroy-and-create: a plain
`terraform apply` against an existing deployment deletes `roma-agent@` and everything bound to
it — its keys included — before making `roma-runtime@`. Do not apply this without picking one
of the two paths below first.

#### Either: hand the name to the agent (recommended)

Keep `roma-agent@`, stop it being roma's runtime identity, and make it the agent's **Cloud
Reach**. The name then stops being an invitation and starts being accurate — `roma-agent@`
really is what the agent acts as — which resolves what the rename was for rather than working
around it. It also means nothing is deleted.

Take the account out of Terraform's hands first, or the apply below will destroy it:

```bash
cd infra
terraform state rm google_service_account.roma
terraform plan     # read this before applying — see what to expect below
terraform apply
```

Expect the plan to create `roma-runtime@`, move `roles/pubsub.subscriber` from `roma-agent@`
to it, and say nothing about `roma-agent@` itself, which is now unmanaged. If it proposes
destroying a service account, stop: the `state rm` did not take.

Two things this does **not** do for you:

- **There is a gap.** The moment the subscriber role moves, a roma still running as
  `roma-agent@` has lost its subscription. Swap roma onto `roma-runtime@` in the same
  window — a new key, or re-attaching the instance's service account. Pick a quiet time.
- **`roma-agent@` keeps living in this project**, which is the one thing the Cloud Reach
  section below recommends against: the agent's identity ends up one IAM binding from the
  ingress it must never touch. That is a real trade rather than a blocker — make it
  knowingly, and read the verification step in that section, which exists for exactly this
  arrangement.

Losing `roles/pubsub.subscriber` is not a side effect to work around; it is required. A Cloud
Reach holding it could consume or acknowledge roma's own ingress, which presents as roma
quietly not answering rather than as an attack.

#### Or: pin the old name and change nothing

If you would rather not touch a running deployment at all, keep `roma-agent@` as roma's
runtime identity:

```hcl
# terraform.tfvars
service_account_id = "roma-agent"
```

Nothing breaks. What you keep is the misleading name, so whoever configures a Cloud Reach
later finds an account called `roma-agent@` and has to be told it is the one account that must
never be one.

## The agent's Cloud Reach

Separate from everything above, and **this directory creates none of it**.

A **Cloud Reach** is one Google Cloud identity the *agent* acts as. A deployment may name one
by pointing `ROMA_CLOUD_KEY_FILE` at its service account key; roma holds that key, never
hands it over, and mints an hour-long token whenever the agent asks (ADR-0015). Leave the
variable unset and roma behaves exactly as it does without one.

**The roles you grant that identity are the whole of the boundary.** Every Conversation
reaches all of it, and so does everyone who can message roma. roma is told which identity to
hand over and nothing about what it may do, so work refused for want of a role is refused by
Google and never by roma.

**Put it in a different project from this one.** This project holds roma's control plane —
the topic, the subscription, the identity roma runs as. A Cloud Reach created here would be
one IAM binding away from the ingress it must never touch, and it would imply the agent's
Google Cloud is roma's. Often it will not be: roma may not run on Google Cloud at all, and
the project the agent works in may belong to somebody else. That is also why there is no
Terraform for it here — a placeholder in this file would put the agent's identity exactly
where it does not belong.

It must **never** be the identity roma itself runs on. An agent standing in roma's own
identity can delete the subscription roma pulls from, publish forged events to the topic roma
trusts, and mint itself a key that outlives every rotation — each of which presents as roma
quietly not working rather than as an attack.

> **Reusing `roma-agent@`?** The rename section above offers exactly that, and it is the one
> case where a Cloud Reach lives in this project on purpose. It is only safe once
> `roles/pubsub.subscriber` has moved off it — follow those steps, then come back and run the
> check below before granting anything broad.

By hand, in the project the agent should work in:

```bash
gcloud config set project THE_AGENTS_PROJECT

gcloud iam service-accounts create roma-cloud-reach \
  --display-name="What roma's agent may touch in Google Cloud"

# Whatever the agent is actually for. Grant narrowly; this is the boundary.
gcloud projects add-iam-policy-binding THE_AGENTS_PROJECT \
  --member="serviceAccount:roma-cloud-reach@THE_AGENTS_PROJECT.iam.gserviceaccount.com" \
  --role="roles/viewer"

gcloud iam service-accounts keys create cloud-reach.json \
  --iam-account="roma-cloud-reach@THE_AGENTS_PROJECT.iam.gserviceaccount.com"
```

Then mount the key read-only and name it:

```bash
export ROMA_CLOUD_KEY_FILE=/run/secrets/cloud-reach.json
```

roma reads it at boot, mints one token with it and throws that token away — so a key that is
unreadable, empty, malformed or revoked stops the boot rather than surfacing inside somebody's
first Task. Rotating it needs a restart.

### Check what a broad role actually reached

`roles/viewer` above is a placeholder for "whatever the agent is for", and the broader the
role the more worth checking it is. Two questions are worth answering before anybody messages
roma, and neither is answerable from roma — it is told which identity to hand over and
nothing about what that identity may do.

**Can it reach the ingress?** This matters whenever the Cloud Reach and the control plane
share a project, which is every deployment that reused `roma-agent@`. Basic roles are broad,
and whether `roles/viewer` carries `pubsub.subscriptions.consume` is not something to take on
trust:

```bash
gcloud pubsub subscriptions pull roma-chat-events-sub \
  --impersonate-service-account=THE_CLOUD_REACH_EMAIL
```

**`PERMISSION_DENIED` is the result you want.** If it pulls a message, the Cloud Reach can eat
roma's own ingress: swap to a narrower role, or bind the readonly role everywhere except this
project.

**How far does it reach?** A role bound at the **organisation** level means every Conversation,
and everyone who can message roma, reads the whole organisation. That may be what you want; it
should not be what you discover. Prefer project-level bindings on the projects the agent is
actually for.

### Standing it up for the first time

Nothing in roma's cloud path has ever run against a real service account (ADR-0015, Status), so
the first deployment is the first evidence. Two steps rather than one keeps the unproven part
isolated:

1. **Deploy with `ROMA_CLOUD_KEY_FILE` unset.** Identical behaviour to a roma without any of
   this, so nothing about the Cloud Reach can be what broke it.
2. **Add the key and restart.** If Google will not mint, roma refuses to boot and says why —
   that is what the boot proof is for. Unset the variable to get straight back to step 1.

The failure mode being "roma will not start" rather than "somebody's Task fails halfway" is the
whole reason the key is proved at boot.

**Know what it is not.** roma is the only thing that reads the key, but the agent runs in the
same container under the same uid, so a shell can read it too — the same gap
`docs/github-app-verification.md` records for the App's PEM. And on a Google host nothing here
stops the agent reaching the metadata server and standing in roma's *own* identity with one
`fetch`; roma has no egress control. That is an argument for keeping the account above at the
`pubsub.subscriber` it has today and nothing more.

## The three numbers this directory decides

Each is a variable with the reasoning next to it in `variables.tf`; the short version:

- **`ack_deadline_seconds = 60`** — nearly irrelevant. What actually holds a message through
  a long Turn is the client library extending the deadline, up to
  `ROMA_PUBSUB_MAX_LEASE_MINUTES`.
- **`message_retention_duration = "604800s"`** — seven days. The outer bound on how long roma
  can be down before a request that arrived is gone rather than late. The dead-letter
  subscription deliberately does **not** follow it and is pinned at Pub/Sub's maximum of 31
  days: shortening how long an unanswered request stays worth answering should not also
  shorten how long a human has to come and look at the ones that failed.
- **`dead_letter_max_delivery_attempts = 100`** — Pub/Sub's ceiling, on purpose. A Task Parked
  on a spent Shared Window is redelivered about once an hour while it is perfectly healthy,
  and every restart costs each in-flight message an attempt. At the usual default of five, an
  overnight Park would be dead-lettered before morning — which is exactly the case roma is
  built to survive.

The subscription also never expires (the default deletes it after 31 days without a
subscriber, and a quiet month would silently delete the thing Chat publishes into) and nacks
back off from 10s to 10m rather than redelivering immediately. Both are commented in
`main.tf`.

## What has actually been checked

`terraform fmt`, `terraform validate`, and a complete `terraform plan` — all 13 resources,
every output rendering, no errors. The variable validations were checked by feeding them bad
values and watching them refuse.

**It has never been applied.** Doing so needs a real Google Cloud project, so the first
person to run it is the first person to find out whether Google agrees. A plan proves the
configuration is coherent and the graph resolves; it does not prove any of these APIs will
accept what it asks for.
