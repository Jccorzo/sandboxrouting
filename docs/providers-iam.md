# Keys, permissions and regions for the big-cloud providers

The big clouds need some setup in their consoles before the router can use them: an identity
or key, sometimes a template, and a region. Each section below covers one provider.

`cloudrun`, `gke-agent-sandbox` and `azure-sandboxes` need a cloud identity and the right role
on it. None of these adapters uses the Google or Azure SDK. They read the credentials below
and mint tokens themselves.

`agentbay`, `tencent`, `volcengine` and `railway` don't sign requests with a cloud AccessKey. Alibaba's ACS3, Tencent's TC3
and Volcengine's v4 signatures aren't needed, because each service also takes a plain API key
made for it. Those keys reach only the sandbox service. Don't give the router an account-wide
AccessKey.

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

## `azure-sandboxes`: Azure Container Apps Sandboxes

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

## Alibaba Cloud AgentBay (`agentbay`)

1. In the [AgentBay console](https://agentbay.console.aliyun.com/), open **Service Management**
   and create an API key (it starts with `akm-`). Put it in `AGENTBAY_API_KEY`.
2. Optional: set `AGENTBAY_REGION` to the region the key belongs to: `cn-hangzhou` (default),
   `ap-southeast-1` or `us-east-1`. The adapter calls `https://agentbay.<region>.aliyuncs.com`.
   `AGENTBAY_API_URL` overrides the whole URL, for example the older
   `https://wuyingai.cn-shanghai.aliyuncs.com` or `https://wuyingai.ap-southeast-1.aliyuncs.com`
   gateways.
3. Optional: `AGENTBAY_IMAGE_ID` picks the image. The default is `code_latest`, whose shell tool
   returns exit codes. A per-request `template: { agentbay: "<image id>" }` overrides it.

No RAM policy is needed at run time: the key goes in the request body and the gateway takes it
without an AccessKey signature. A RAM user who manages keys in the console needs access to the
AgentBay console. The free Basic plan allows 10 concurrent sessions, but compute is billed from
the first second, so the account needs a payment method.

## Tencent Cloud Agent Sandbox (`tencent`)

1. In the [Agent Runtime console](https://console.cloud.tencent.com/), open **Agent 沙箱 >
   API Keys**, create a key (`e2b_…`) and put it in `TENCENT_AGS_API_KEY`.
2. Open **沙箱工具** and create a sandbox tool: Code Interpreter for plain commands, or Custom
   for your own image and size. Put its name in `TENCENT_AGS_TOOL`. The tool fixes the size
   (Code Interpreter: 2 vCPU, 1000 MiB). A per-request `template: { tencent: "<tool>" }`
   picks another tool.
3. Optional: `TENCENT_AGS_REGION` (default `ap-guangzhou`) makes the domain
   `<region>.tencentags.com`. Only Guangzhou appears in the docs. For other regions, check the
   domain in the console and set `TENCENT_AGS_DOMAIN` if it differs.

The key and the tool belong to one region. The default quota per account and region is
10 tools, 50 instances, 50 vCPU, 100 GiB of memory and 20 paused instances. Quota increases go
through Tencent's online support. A CAM sub-account that creates keys or tools needs Agent
Runtime permissions in CAM. The router itself only uses the API key.

## Volcengine AgentKit Sandbox (`volcengine`)

1. In the [AgentKit console](https://console.volcengine.com/agentkit), open **沙箱模板** and
   click **创建 E2B API Key**. Copy the full key (`e2b_apikey_…`); it is shown only once. Put it
   in `VOLCENGINE_E2B_API_KEY`.
2. Create a sandbox template (a preset such as Code Sandbox, or your own image) with **E2B 协议兼容**
   turned on. Copy `E2B_TEMPLATE_ID` from its **配置信息** tab into
   `VOLCENGINE_E2B_TEMPLATE_ID`. The template fixes the image and size.
3. Optional: `VOLCENGINE_E2B_REGION` is `cn-beijing` (default) or `cn-shanghai`. The control
   plane is `https://api.vefaas-e2b.sandbox-<region>.volcapig.com`, and
   `VOLCENGINE_E2B_API_URL` overrides it.

The account must have AgentKit enabled and the E2B-compatible feature enabled in that region.
The user who makes the template needs permission to create templates and keys. In the
template's **权限与访问控制** section, you can attach an IAM role that the sandbox itself
assumes. The router doesn't use that role. Keys are listed under **身份与权限 > 凭据管理**.

veFaaS lacks E2B's `connect` call. Only the process that created a sandbox can run commands in
it, and a paused sandbox can't be resumed through the SDK.

## Railway Sandboxes (`railway`)

1. In the Railway project, open **Settings > Tokens** and create a project token for the
   environment the sandboxes should live in. Put it in `RAILWAY_TOKEN`. The token names its
   environment, so nothing else is needed.
2. Or use an account or workspace token in `RAILWAY_API_TOKEN` and name the environment in
   `RAILWAY_ENVIRONMENT_ID`. These tokens reach every project the account can, so a project
   token is the safer choice.
3. Optional: a request's `region` (a Railway region id such as `us-east4-eqdc4a`) is passed
   through. Without it, Railway runs a fresh sandbox in US West (`us-west2`).

Each sandbox lives in the token's environment and counts toward that environment's cap:
10 running on Trial and Free, 50 on Hobby, 100 on Pro. On Trial and Free, the idle timeout is
5 minutes at most. The adapter asks for the request's lifetime in minutes, so a longer timeout
needs Hobby or Pro, or `providers.railway.options.idleTimeoutMinutes`.
