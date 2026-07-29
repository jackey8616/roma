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
| `roma-agent@…` | the service account roma runs as |
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
