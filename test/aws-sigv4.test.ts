// SigV4 against AWS's published test suite. Requests and expected Authorization headers are
// copied from the aws-c-auth copy of the suite (tests/aws-signing-test-suite/v4/<case>/request.txt
// and header-signed-request.txt, https://github.com/awslabs/aws-c-auth, fetched 2026-11-22). All
// cases use AKIDEXAMPLE, region us-east-1, service `service`, 2015-08-30T12:36:00Z.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsCredentials, awsRegion, signV4, type SigV4Request } from "../src/providers/aws-sigv4.js";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const date = new Date("2015-08-30T12:36:00Z");
const host = "example.amazonaws.com";
const scope = "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request";
const XDATE = { "X-Amz-Date": "20150830T123600Z" };

const cases: [string, Omit<SigV4Request, "host">, { token?: string; signBody?: boolean }, string, string][] = [
  ["get-vanilla", { method: "GET", path: "/", headers: XDATE }, {}, "host;x-amz-date", "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"],
  ["get-vanilla-query-order-key-case", { method: "GET", path: "/", query: "Param2=value2&Param1=value1", headers: XDATE }, {}, "host;x-amz-date", "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"],
  ["get-vanilla-query-order-encoded", { method: "GET", path: "/", query: "Param-3=Value3&Param=Value2&%E1%88%B4=Value1", headers: XDATE }, {}, "host;x-amz-date", "371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac"],
  ["get-vanilla-utf8-query", { method: "GET", path: "/", query: "ሴ=bar", headers: XDATE }, {}, "host;x-amz-date", "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04"],
  ["get-utf8", { method: "GET", path: "/ሴ", headers: XDATE }, {}, "host;x-amz-date", "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85"],
  ["get-space-normalized", { method: "GET", path: "/example space/", headers: XDATE }, {}, "host;x-amz-date", "652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741"],
  ["get-slash-dot-slash-normalized", { method: "GET", path: "/./", headers: XDATE }, {}, "host;x-amz-date", "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"],
  [
    "get-header-value-trim",
    { method: "GET", path: "/", headers: { "My-Header1": " value1", "My-Header2": ' "a   b   c"', ...XDATE } },
    {},
    "host;my-header1;my-header2;x-amz-date",
    "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
  ],
  [
    "get-vanilla-with-session-token",
    { method: "GET", path: "/", headers: XDATE },
    { token: "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267" },
    "host;x-amz-date;x-amz-security-token",
    "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8",
  ],
  ["post-vanilla-query", { method: "POST", path: "/", query: "Param1=value1", headers: XDATE }, {}, "host;x-amz-date", "28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11"],
  [
    "post-x-www-form-urlencoded",
    { method: "POST", path: "/", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "13", ...XDATE }, body: "Param1=value1" },
    { signBody: true },
    "content-length;content-type;host;x-amz-content-sha256;x-amz-date",
    "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
  ],
];

describe("SigV4 test suite", () => {
  it.each(cases)("%s", (_name, req, o, signed, signature) => {
    const creds = o.token ? { ...credentials, sessionToken: o.token } : credentials;
    const headers = signV4({ ...req, host }, { region: "us-east-1", service: "service", credentials: creds, date, signBody: o.signBody });
    expect(headers["authorization"]).toBe(`AWS4-HMAC-SHA256 ${scope}, SignedHeaders=${signed}, Signature=${signature}`);
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
    if (o.token) expect(headers["x-amz-security-token"]).toBe(o.token);
    if (o.signBody) expect(headers["x-amz-content-sha256"]).toBe("9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e");
    // fetch sets Host from the URL; a host header of our own would be refused or duplicated.
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("host");
  });

  it("encodes an already-encoded path once more, as non-S3 services expect", () => {
    // An ARN label is sent as %3A; AWS signs the wire path encoded again (%253A).
    const a = signV4({ method: "GET", host, path: "/a%3Ab" }, { region: "us-east-1", service: "service", credentials, date });
    const b = signV4({ method: "GET", host, path: "/a%253Ab" }, { region: "us-east-1", service: "service", credentials, date });
    expect(a["authorization"]).not.toBe(b["authorization"]);
  });
});

describe("AWS credentials and region", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbr-aws-"));
  const none = { AWS_CONFIG_FILE: join(dir, "nope"), AWS_SHARED_CREDENTIALS_FILE: join(dir, "nope") };

  it("reads the environment first, with the session token", async () => {
    expect(await awsCredentials({ ...none, AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_SESSION_TOKEN: "T" })).toEqual({ accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "T" });
    expect(await awsRegion({ ...none, AWS_DEFAULT_REGION: "eu-west-1" })).toBe("eu-west-1");
    expect(await awsRegion({ ...none, AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "eu-west-1" })).toBe("us-west-2");
  });

  it("falls back to the shared files for the default or AWS_PROFILE profile", async () => {
    const credentialsFile = join(dir, "credentials");
    const configFile = join(dir, "config");
    writeFileSync(credentialsFile, "[default]\naws_access_key_id = DK\naws_secret_access_key = DS\n\n[work]\naws_access_key_id=WK\naws_secret_access_key=WS\naws_session_token=WT\n");
    writeFileSync(configFile, "# comment\n[default]\nregion = ap-south-1\n[profile work]\nregion = eu-central-1\n[profile sso]\nsso_session = corp\n");
    const files = { AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile };
    expect(await awsCredentials(files)).toEqual({ accessKeyId: "DK", secretAccessKey: "DS" });
    expect(await awsRegion(files)).toBe("ap-south-1");
    // AWS_PROFILE wins over env keys, as in the SDK's default chain.
    const work = { ...files, AWS_PROFILE: "work", AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" };
    expect(await awsCredentials(work)).toEqual({ accessKeyId: "WK", secretAccessKey: "WS", sessionToken: "WT" });
    expect(await awsRegion(work)).toBe("eu-central-1");
    expect(await awsCredentials({ ...files, AWS_PROFILE: "sso" })).toEqual({ missing: expect.stringMatching(/sso_session/) });
  });

  it("says what is missing when nothing is set", async () => {
    expect(await awsCredentials(none)).toEqual({ missing: expect.stringMatching(/AWS_ACCESS_KEY_ID/) });
    expect(await awsRegion(none)).toBeUndefined();
  });
});
