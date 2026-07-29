# The outputs are named for `README.md`'s environment table, in lowercase. That
# is the whole point of them: standing roma up should be an apply followed by
# exporting what it printed, not reading two documents and hoping they agree.

output "roma_pubsub_project_id" {
  value       = var.project_id
  description = "`ROMA_PUBSUB_PROJECT_ID`."
}

output "roma_pubsub_subscription" {
  value       = google_pubsub_subscription.roma.name
  description = "`ROMA_PUBSUB_SUBSCRIPTION`. The bare name, which is what roma reads."
}

output "roma_environment" {
  description = "The two required Pub/Sub variables, ready to paste. `terraform output -raw roma_environment`."
  value       = <<-EOT
    export ROMA_PUBSUB_PROJECT_ID=${var.project_id}
    export ROMA_PUBSUB_SUBSCRIPTION=${google_pubsub_subscription.roma.name}
  EOT
}

output "chat_events_topic" {
  value       = google_pubsub_topic.chat_events.id
  description = "The full `projects/…/topics/…` name the Chat app's configuration form asks for. Not read by roma."
}

output "roma_service_account_email" {
  value       = google_service_account.roma.email
  description = "Who roma runs as. Mint a key for it, or attach it to the host — see README.md."
}

output "dead_letter_subscription" {
  value       = google_pubsub_subscription.dead_letter.name
  description = "Where to look for a message roma could never answer. Nothing reads it; somebody has to."
}
