# Cloud Run sandbox image for sandboxrouting

Cloud Run sandboxes have no API of their own: the `sandbox` CLI that starts them exists only
inside a Cloud Run container deployed with `sandboxLauncher: true`. So the router creates one
Cloud Run **instance** (Preview) per sandbox from this image, and this image's `execd.mjs`, a
dependency-free server on port 8080, starts a detached sandbox and runs every command in it
with `sandbox exec`.

1. Build and push the image to Artifact Registry in your project:

   ```bash
   gcloud artifacts repositories create sbr --repository-format=docker --location=us-west1
   gcloud builds submit --tag us-west1-docker.pkg.dev/PROJECT/sbr/cloud-run-sandbox templates/cloud-run-sandbox
   ```

2. Give the router the project, a region that has Cloud Run instances (not `us-central1`,
   `us-east1` or `europe-west1`), the image, and a credential (see docs/providers-iam.md):

   ```dotenv
   GOOGLE_CLOUD_PROJECT=my-project
   CLOUD_RUN_REGION=us-west1
   CLOUD_RUN_SANDBOX_IMAGE=us-west1-docker.pkg.dev/my-project/sbr/cloud-run-sandbox
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
   ```

3. `sbr check --provider cloudrun`

The sandbox sees this image's file system read-only with a writable overlay, so add the tools
your commands need to the Dockerfile. Outbound network is on (`--allow-egress`); set
`"cloudrun": { "options": { "allowEgress": false } }` to turn it off. Sandboxes never get the
instance's metadata-server credentials.

Each instance gets a random token in its `SBR_TOKEN` variable, and execd refuses requests
without it. By default the instance's URL skips Cloud Run's IAM check (`invokerIamDisabled`), so
the token is the only gate; set `"options": { "invokerIam": true }` to keep IAM as well (the
router then sends an ID token, which needs a service-account key). At its deadline execd deletes
the sandbox and exits, which stops the instance; the router deletes it then too.
