terraform {
  # 1.5 for `check` blocks and the stable `import` block. Nothing here uses
  # either yet; the floor is set so that a reader knows which language this was
  # written against rather than discovering it from an error.
  required_version = ">= 1.5"

  required_providers {
    google = {
      source = "hashicorp/google"
      # Pinned to a major, floating within it. `.terraform.lock.hcl` is committed
      # alongside this and is what actually decides the version — the constraint
      # only says which upgrades are allowed to be considered.
      version = "~> 7.42"
    }
  }
}

# No backend block, so state is a file in this directory.
#
# Deliberate, and safe here for one reason worth stating: nothing below creates a
# secret. There is no service account key, no password, no token — the state
# holds resource names, a project number and two IAM members, all of which are
# already visible to anyone who can read the project. A configuration that
# created roma's key would need a remote backend with encryption before it could
# be run at all.
#
# It still means one person's laptop holds the record of what exists. Adding a
# `backend "gcs"` block is the right move the moment more than one person applies
# this, and it changes nothing else in here.

provider "google" {
  # Every resource below inherits this rather than repeating `project`, so there
  # is exactly one place the answer to "which project did this go into" lives.
  project = var.project_id
}
