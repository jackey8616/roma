variable "project_id" {
  type        = string
  description = <<-EOT
    The Google Cloud project the topic, the subscription and roma's service
    account go into. The only variable with no default: there is no sensible
    guess, and a wrong one would provision into somebody else's project.

    This is also what `ROMA_PUBSUB_PROJECT_ID` is set to — see the outputs.
  EOT

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "A project id is 6-30 characters, lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "topic_name" {
  type        = string
  default     = "roma-chat-events"
  description = <<-EOT
    The topic Google Chat publishes interaction events to.

    Named in the Chat app's configuration form, not in roma's environment — roma
    never learns the topic exists. Changing it after the app is configured means
    changing it in the console too, in that order.
  EOT
}

variable "subscription_name" {
  type        = string
  default     = "roma-chat-events-sub"
  description = <<-EOT
    The subscription roma pulls from. This is `ROMA_PUBSUB_SUBSCRIPTION`.

    A name within the project, not a path — `readChatEnv` takes the bare name and
    the client library builds the path, so `projects/.../subscriptions/...` here
    would be wrong twice over.
  EOT
}

variable "service_account_id" {
  type = string
  # Not "roma", which Google will not accept: a service account id has a floor of
  # six characters, and the refusal arrives from the API rather than from here.
  #
  # **This default changed from `roma-agent` to `roma-runtime`**, and a Google
  # Cloud account id is immutable — so applying this against an existing
  # deployment is a destroy-and-create of the service account, its key and every
  # grant bound to it. Pin `service_account_id = "roma-agent"` in
  # `terraform.tfvars` to keep what you have; nothing else about the change is
  # load-bearing.
  default     = "roma-runtime"
  description = <<-EOT
    The account id of the identity roma runs as — the local part of its email.

    This is the identity behind `GOOGLE_APPLICATION_CREDENTIALS`, or the one
    attached to the instance when roma runs on a Google host and that variable is
    unset.

    Named `roma-runtime` and **not** `roma-agent`, which it used to be. In roma's
    vocabulary the agent is the Claude Code process, and this is precisely the
    identity the agent's Cloud Reach must never be — one that could reach roma's
    own ingress could delete the subscription roma pulls from or publish forged
    events to its topic, each of which presents as roma quietly not working
    rather than as an attack (ADR-0015 §2). The old name was not merely
    imprecise, it was an invitation: somebody configuring the agent's Google
    Cloud access found an account named for exactly what they were setting up.

    An existing deployment should pin the old value rather than recreate the
    account — see the comment above.
  EOT

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.service_account_id))
    error_message = "A service account id is 6-30 characters, lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "dead_letter_topic_name" {
  type        = string
  default     = "roma-chat-events-dead-letter"
  description = "Where a message goes once it has been delivered too many times. Nothing reads it; see main.tf for why it exists anyway."
}

variable "ack_deadline_seconds" {
  type        = number
  default     = 60
  description = <<-EOT
    How long Pub/Sub waits for roma to settle a Delivery before it hands the
    message to somebody again.

    Sixty, and it is close to irrelevant on purpose: the client library extends
    the deadline for as long as `ROMA_PUBSUB_MAX_LEASE_MINUTES` allows, so this
    number governs only the window before the first extension lands. Pub/Sub's
    own ceiling is 600, and setting it high here would not help — what actually
    holds a message through a minutes-long Turn is the extension, not this.
  EOT

  validation {
    condition     = var.ack_deadline_seconds >= 10 && var.ack_deadline_seconds <= 600
    error_message = "Pub/Sub allows an acknowledgement deadline between 10 and 600 seconds."
  }
}

variable "message_retention_duration" {
  type        = string
  default     = "604800s"
  description = <<-EOT
    How long the subscription keeps a message roma has not settled.

    Seven days, written out rather than left to the default it happens to match,
    because the number has a reason: a Task Parked on a spent Shared Window is
    still holding its message, and the window can come back hours later. Seven
    days is the outer bound on how long roma can be down — or one Task Parked —
    before the request that arrived is gone rather than late.
  EOT

  validation {
    condition     = can(regex("^[0-9]+(\\.[0-9]+)?s$", var.message_retention_duration))
    error_message = "Give a duration in seconds with an `s` suffix, e.g. \"604800s\". Pub/Sub accepts 10 minutes to 31 days."
  }
}

variable "dead_letter_max_delivery_attempts" {
  type        = number
  default     = 100
  description = <<-EOT
    How many deliveries a message gets before Pub/Sub moves it to the dead-letter
    topic.

    A hundred — Pub/Sub's ceiling — and the height is the decision, not an
    oversight. On this subscription a redelivery is a poor measure of badness:

      - A Task Parked on a spent Shared Window holds its message past
        `ROMA_PUBSUB_MAX_LEASE_MINUTES`, so the message is delivered again while
        the Task it carries is alive and well. `serve.ts` recognises the
        redelivery as work already in flight and leaves it unsettled, which means
        it will happen again about once an hour for as long as the Task is
        Parked.
      - Shutting roma down hands every in-flight Delivery back on purpose, so a
        restart costs every message in flight one attempt.

    At five — the default anyone reaches for — an overnight Park would be
    dead-lettered before morning, which is precisely the case roma is built to
    survive. At a hundred the escape hatch is still there for a message that
    genuinely cannot be answered, and no healthy message reaches it.
  EOT

  validation {
    condition     = var.dead_letter_max_delivery_attempts >= 5 && var.dead_letter_max_delivery_attempts <= 100
    error_message = "Pub/Sub allows between 5 and 100 delivery attempts before dead-lettering."
  }
}
