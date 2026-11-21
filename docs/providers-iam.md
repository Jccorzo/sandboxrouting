# IAM setup for the hyperscaler providers

`cloudrun`, `gke-agent-sandbox` and `azure-sessions` need a cloud identity and the right role
on it. None of these adapters uses the Google or Azure SDK. They read the credentials below
and mint tokens themselves.

## Google credentials (`cloudrun`, and `gke-agent-sandbox` on GKE)

The first one that is set wins:

| Variable | What it holds |
|---|---|
| `GOOGLE_OAUTH_ACCESS_TOKEN` | An access token, e.g. `gcloud auth print-access-token`. It expires after an hour, so use it for short runs. |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | A key file's JSON, inline. |
| `GOOGLE_APPLICATION_CREDENTIALS` | The path to a key file: a service-account key, or the `authorized_user` file that `gcloud auth application-default login` writes. |

A service-account key is signed locally (RS256 JWT) and exchanged at Google's token endpoint
for a `cloud-platform` access token, which the adapter caches until a minute before it expires.

## `cloudrun`: Cloud Run sandboxes

Each router sandbox is one Cloud Run instance (Preview) running
[templates/cloud-run-sandbox](../templates/cloud-run-sandbox).

```bash
PROJECT=my-project REGION=us-west1          # instances aren't offered in us-central1, us-east1, europe-west1
gcloud services enable run.googleapis.com artifactregistry.googleapis.com --project $PROJECT
gcloud iam service-accounts create sbr-router --project $PROJECT
SA=sbr-router@$PROJECT.iam.gserviceaccount.com

# Create, read, list and delete instances.
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SA --role roles/run.developer
# Deploy instances that run as the runtime identity (the default compute SA, or CLOUD_RUN_SERVICE_ACCOUNT).
gcloud iam service-accounts add-iam-policy-binding $(gcloud projects describe $PROJECT --format 'value(projectNumber)')-compute@developer.gserviceaccount.com \
  --member serviceAccount:$SA --role roles/iam.serviceAccountUser --project $PROJECT
gcloud iam service-accounts keys create key.json --iam-account $SA
```

| Variable | Required | Meaning |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | yes | Project id. |
| `CLOUD_RUN_REGION` | yes | Region for the instances. |
| `CLOUD_RUN_SANDBOX_IMAGE` | yes | The execd image you pushed (or `options.image`). |
| Google credential | yes | See above. |
| `CLOUD_RUN_SERVICE_ACCOUNT` | no | Runtime identity for the instances (or `options.serviceAccount`). Sandboxes never see its credentials. |

Instances are created with `invokerIamDisabled: true`, so their URL skips Cloud Run's IAM
check. A random per-instance token, which execd checks, is the gate. If an organization policy
forbids unauthenticated invocation (domain-restricted sharing), set
`"cloudrun": { "options": { "invokerIam": true } }`. The router then signs an ID token for each
instance URL, which needs a service-account key, and that account also needs
`roles/run.invoker`.

## `gke-agent-sandbox`: Agent Sandbox in your cluster

Install [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) with its extensions,
create a `SandboxWarmPool` whose template runs sandboxd, and expose the sandbox-router outside
the cluster (a Gateway or a LoadBalancer Service). The router identity needs, in the sandbox
namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: sandboxrouting, namespace: team }
rules:
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxclaims"]
    verbs: ["create", "get", "list", "patch", "delete"]
```

Bind it to a Kubernetes ServiceAccount and pass that account's token, or on GKE grant a Google
identity `roles/container.developer` (or bind the Role to its email) and use Google credentials.
If the sandbox-router runs with `--authz-mode=tokenreview`, the same token authenticates there.

| Variable | Required | Meaning |
|---|---|---|
| `AGENT_SANDBOX_K8S_API` | yes | The API server URL, e.g. `https://34.1.2.3` (`gcloud container clusters describe … --format 'value(endpoint)'`). |
| `AGENT_SANDBOX_ROUTER_URL` | yes | Where the sandbox-router answers from outside the cluster. |
| `AGENT_SANDBOX_WARM_POOL` | yes | The `SandboxWarmPool` to claim from (or `options.warmPool`; a template `--template gke-agent-sandbox=<pool>` overrides it). |
| `AGENT_SANDBOX_K8S_TOKEN` | one of these | A Kubernetes bearer token. |
| Google credential | one of these | GKE accepts Google access tokens. |
| `AGENT_SANDBOX_NAMESPACE` | no | Default `default`. |
| `AGENT_SANDBOX_ROUTER_TOKEN` | no | For a router in `scoped-token` mode. |
| `AGENT_SANDBOX_SANDBOXD_TOKEN` | no | When sandboxd runs with `--auth-token-file`. |
| `NODE_EXTRA_CA_CERTS` | no | The cluster CA, when Node doesn't trust it (GKE's is private). |

Files go through sandboxd's REST API only under its root (`/workspace`, or `options.rootDir`);
other paths fall back to exec.

## `azure-sessions`: Azure Container Apps Sandboxes

Create a sandbox group, then give the router identity the *Container Apps SandboxGroup Data
Owner* role on it:

```bash
az group create -n sbr-rg -l eastus2
az resource create -g sbr-rg -n sbr-group --resource-type Microsoft.App/sandboxGroups \
  --api-version 2026-02-01-preview --properties '{}' -l eastus2
az ad sp create-for-rbac -n sbr-router          # prints appId (client id), password (secret), tenant
az role assignment create --assignee <appId> --role "Container Apps SandboxGroup Data Owner" \
  --scope /subscriptions/<sub>/resourceGroups/sbr-rg/providers/Microsoft.App/sandboxGroups/sbr-group
```

| Variable | Required | Meaning |
|---|---|---|
| `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_SANDBOX_GROUP` | yes | Where the sandbox group lives. |
| `AZURE_REGION` | yes | Its region without spaces (`eastus2`): the data plane is `management.<region>.azuredevcompute.io`. |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | one of these | A service principal. The adapter runs the client-credentials flow for the `https://dynamicsessions.io` audience. |
| `AZURE_ACCESS_TOKEN` | one of these | A token for that audience: `az account get-access-token --resource https://dynamicsessions.io`. Expires in about an hour. |
| `AZURE_AUTHORITY_HOST` | no | Another cloud's login host (default `https://login.microsoftonline.com`). |
