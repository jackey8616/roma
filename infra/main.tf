data "google_project" "this" {
  project_id = var.project_id

  # Reading a project goes through the Cloud Resource Manager API, which an empty
  # project need not have on. The dependency is what defers this read from plan
  # time to apply time on the first run, once the API is actually enabled;
  # afterwards there is nothing pending, Terraform reads it during plan as usual,
  # and a re-apply stays the no-op it is supposed to be.
  depends_on = [google_project_service.cloudresourcemanager]
}

locals {
  # The identity Google Chat publishes as. Google's, fixed, and the same in every
  # project — a local rather than a variable because it is not anybody's to
  # choose. Getting it wrong does not produce an IAM error: it produces a Chat
  # configuration form that refuses the topic, and the refusal reads as a problem
  # with Chat rather than with a missing grant.
  chat_publisher = "serviceAccount:chat-api-push@system.gserviceaccount.com"

  # The identity Pub/Sub itself acts as when it moves a message to the
  # dead-letter topic. Created when the Pub/Sub API is enabled, and addressed
  # from the project number, so there is nothing to look up.
  pubsub_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# --------------------------------------------------------------------------
# APIs
# --------------------------------------------------------------------------

# `disable_on_destroy = false` on both: destroying what this configuration made
# should take away a topic and a service account, not turn off an API that
# anything else in the project may have come to depend on since.

resource "google_project_service" "pubsub" {
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

# The two an established project almost certainly has on already, and an empty one
# — which is the project the acceptance criterion names — may not. Cheap to
# declare, and the failure without them arrives as a permission error against an
# API nobody mentioned rather than as "turn this on".
resource "google_project_service" "iam" {
  service            = "iam.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "cloudresourcemanager" {
  service            = "cloudresourcemanager.googleapis.com"
  disable_on_destroy = false
}

# Not used by anything below, and enabled anyway: configuring the Chat app is a
# console form on this project, and the form is not reachable until the API is
# on. It is the first of the manual steps in README.md, so it is the last thing
# that should be manual itself.
resource "google_project_service" "chat" {
  service            = "chat.googleapis.com"
  disable_on_destroy = false
}

# --------------------------------------------------------------------------
# The topic Chat publishes to
# --------------------------------------------------------------------------

resource "google_pubsub_topic" "chat_events" {
  name       = var.topic_name
  depends_on = [google_project_service.pubsub]
}

# The grant without which the Chat app's configuration form will not accept the
# topic at all. It is the whole reason this file exists rather than a paragraph
# of console instructions.
resource "google_pubsub_topic_iam_member" "chat_publisher" {
  topic  = google_pubsub_topic.chat_events.name
  role   = "roles/pubsub.publisher"
  member = local.chat_publisher
}

# --------------------------------------------------------------------------
# The subscription roma reads
# --------------------------------------------------------------------------

resource "google_pubsub_subscription" "roma" {
  name  = var.subscription_name
  topic = google_pubsub_topic.chat_events.id

  ack_deadline_seconds       = var.ack_deadline_seconds
  message_retention_duration = var.message_retention_duration

  # A message is worth keeping until it is answered and worth nothing after, and
  # roma has no replay story that would use the settled ones.
  retain_acked_messages = false

  # Never expires. The default is deletion after 31 days without an active
  # subscriber, which is a reasonable rule for a subscription somebody forgot and
  # a disaster for this one: a quiet month — a holiday, a team that went back to
  # doing it by hand — would silently delete the thing Chat publishes into, and
  # the symptom is a roma that starts, reports healthy, and never hears anything
  # again.
  expiration_policy {
    ttl = ""
  }

  # roma hands a Delivery back when the Core failed to reach the Channel, which
  # is usually the Chat API being briefly unreachable. Immediate redelivery — the
  # behaviour with no policy at all — turns that into a spin against an API that
  # is already unhappy. Ten seconds to ten minutes gives it room to come back.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  # Message ordering is deliberately off. roma already answers one Task per
  # Conversation at a time — that is the Task Queue's job — so ordering keys
  # would re-decide, at the queue, something the Core has already decided, and
  # would hold up every Conversation behind the slowest.

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = var.dead_letter_max_delivery_attempts
  }
}

resource "google_pubsub_subscription_iam_member" "roma_subscriber" {
  subscription = google_pubsub_subscription.roma.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.roma.email}"
}

# --------------------------------------------------------------------------
# The dead-letter path
# --------------------------------------------------------------------------

resource "google_pubsub_topic" "dead_letter" {
  name       = var.dead_letter_topic_name
  depends_on = [google_project_service.pubsub]
}

# Nothing reads this, and it exists anyway.
#
# A topic with no subscription discards everything published to it, so a
# dead-letter topic on its own is an elaborate way to delete a message. This is
# what makes "dead-lettered" mean "set aside where somebody can go and look",
# which is the only reading under which the policy above is a safety net rather
# than a second way to lose a request.
resource "google_pubsub_subscription" "dead_letter" {
  name  = "${var.dead_letter_topic_name}-sub"
  topic = google_pubsub_topic.dead_letter.id

  # 31 days — Pub/Sub's maximum — and deliberately not
  # `var.message_retention_duration`. That number bounds how long an unanswered
  # request is still worth answering, and shortening it is a reasonable thing for
  # somebody to do. This one bounds how long a message nobody could answer waits
  # for a human to come and look at it, which is the one store that wants more
  # time rather than less. Tied together, lowering the first would quietly delete
  # the evidence for the second.
  message_retention_duration = "2678400s"

  expiration_policy {
    ttl = ""
  }
}

# Pub/Sub moves the message as itself, not as roma, so these two are grants to
# Google's own service agent. Both are required and the failure without them is
# quiet: the delivery attempts keep climbing and nothing is ever dead-lettered.
resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  topic  = google_pubsub_topic.dead_letter.name
  role   = "roles/pubsub.publisher"
  member = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "dead_letter_forwarder" {
  subscription = google_pubsub_subscription.roma.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}

# --------------------------------------------------------------------------
# Who roma is
# --------------------------------------------------------------------------

# The identity, and only the identity. No key is created here on purpose: a
# `google_service_account_key` resource puts the private key in Terraform state
# in plaintext, which would turn the state file into a credential and this
# directory into something that cannot be applied from a laptop. README.md says
# how to mint one by hand, and how to need no key at all on a Google host.
resource "google_service_account" "roma" {
  account_id   = var.service_account_id
  display_name = "roma"
  description  = "The agent that answers Google Chat. Reads the ingress subscription; provisions nothing."
  depends_on   = [google_project_service.iam]
}

# There is deliberately no grant for the outbound side. roma posts to Chat as the
# Chat app, and an app's authority in a space comes from being installed in that
# space — there is no project IAM role that grants it and none is missing here.
