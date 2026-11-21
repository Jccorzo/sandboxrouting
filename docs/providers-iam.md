# Keys, permissions and regions for the big-cloud providers

The big clouds need a little setup in their consoles before the router can use them: a key,
sometimes a template, and a region. Each section below covers one provider.

None of these adapters signs requests with a cloud AccessKey. Alibaba's ACS3, Tencent's TC3
and Volcengine's v4 signatures aren't needed, because each service also takes a plain API key
made for it. Those keys reach only the sandbox service. Don't give the router an account-wide
AccessKey.

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
