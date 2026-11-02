/**
 * Railway's API, for Settings → Web address (adding the owner's domain to this instance's crewtavo
 * service, watching Railway verify it, and switching APP_URL over) and Settings → Hosting (what
 * Railway charges, for the twice-daily warnings, and moving files to a storage bucket and back).
 * Crewtavo gets access one of two ways: Login with
 * Railway (OAuth; each instance registers its own client with Railway, so nobody runs a shared app)
 * or a project token the owner pastes.
 *
 * The project, environment and service come from the variables Railway sets on every deployment
 * (RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID).
 */
import type { Env } from "../env";
import { toBase64Url } from "../lib/crypto";
import type { WantedRecord } from "../lib/dns";

const BACKBOARD = "https://backboard.railway.com";
/**
 * Member of the project: it reads the project's usage, forecast inputs and volumes too. Not the
 * workspace's billing: that takes workspace:admin, which Railway shows owners as "full control of
 * your account" in red, and a sign-in asking for both was refused the project (tried 2026-10-20).
 */
export const SCOPE = "openid project:member offline_access";
const timeout = () => AbortSignal.timeout(15_000);

export class RailwayError extends Error {
  /** `denied`: Railway refused the call for this access (401/403, or "Not Authorized"). */
  constructor(message: string, readonly status = 0, readonly denied = false) {
    super(message);
  }
}

/** This instance's own OAuth client at Railway (RFC 7591 dynamic registration). */
export interface RailwayClient {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  /** What it was registered to ask for, when that was recorded: a client made for a different SCOPE is registered again. */
  scope?: string;
  registration_access_token?: string;
  registration_client_uri?: string;
}

export interface RailwayAccess {
  method: "oauth" | "token";
  /** OAuth access token, or the pasted project token. */
  token: string;
  refresh_token?: string;
  expires_at?: number; // ms since epoch
  /** What Railway granted, from the token response: for the log when a call is refused. */
  granted?: string;
}

interface Ids {
  projectId: string;
  environmentId: string;
  serviceId: string;
}

export function railwayIds(env: Env): Ids | null {
  const { RAILWAY_PROJECT_ID: projectId, RAILWAY_ENVIRONMENT_ID: environmentId, RAILWAY_SERVICE_ID: serviceId } = env;
  return projectId && environmentId && serviceId ? { projectId, environmentId, serviceId } : null;
}

function ids(env: Env): Ids {
  const found = railwayIds(env);
  if (!found) throw new RailwayError("Crewtavo can't tell which Railway project it's in. Add the address by hand instead.");
  return found;
}

// ---------------------------------------------------------------------------------------------
// Login with Railway
// ---------------------------------------------------------------------------------------------

export async function registerClient(redirectUri: string, name: string): Promise<RailwayClient> {
  const res = await fetch(`${BACKBOARD}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: name.slice(0, 80),
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      application_type: "web",
      scope: SCOPE,
    }),
    signal: timeout(),
  }).catch(() => null);
  const json = (await res?.json().catch(() => ({}))) as Partial<RailwayClient> & { error_description?: string };
  if (!res?.ok || !json.client_id || !json.client_secret) {
    throw new RailwayError(`Railway didn't let Crewtavo sign in for you${json.error_description ? ` (${json.error_description})` : ""}. Use a project token instead.`, res?.status ?? 0);
  }
  return {
    client_id: json.client_id,
    client_secret: json.client_secret,
    redirect_uri: redirectUri,
    scope: SCOPE,
    registration_access_token: json.registration_access_token,
    registration_client_uri: json.registration_client_uri,
  };
}

/** PKCE: the verifier stays with us; Railway sees its hash first and the verifier only at the token exchange. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: toBase64Url(digest) };
}

export function authorizationUrl(client: RailwayClient, state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Needed for a refresh token, and lets the owner pick the project each time.
    prompt: "consent",
  });
  return `${BACKBOARD}/oauth/auth?${params}`;
}

async function tokenRequest(client: RailwayClient, form: Record<string, string>): Promise<RailwayAccess> {
  const res = await fetch(`${BACKBOARD}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`,
    },
    body: new URLSearchParams(form),
    signal: timeout(),
  }).catch(() => null);
  const json = (await res?.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
  if (!res?.ok || !json.access_token) throw new RailwayError(`Railway didn't accept the sign-in${json.error ? ` (${json.error})` : ""}. Try logging in with Railway again.`, res?.status ?? 0);
  return { method: "oauth", token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + (json.expires_in ?? 3600) * 1000, granted: json.scope };
}

export const exchangeCode = (client: RailwayClient, code: string, verifier: string) =>
  tokenRequest(client, { grant_type: "authorization_code", code, redirect_uri: client.redirect_uri, code_verifier: verifier });

/** A fresh access token. Railway rotates refresh tokens: keep the one that comes back. */
export async function refreshAccess(client: RailwayClient, access: RailwayAccess): Promise<RailwayAccess> {
  if (!access.refresh_token) throw new RailwayError("Crewtavo's Railway sign-in ran out. Log in with Railway again.");
  const next = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: access.refresh_token });
  return { ...next, refresh_token: next.refresh_token ?? access.refresh_token };
}

/** Best effort: remove this instance's OAuth client from Railway, which ends its access too. */
export async function deleteClient(client: RailwayClient): Promise<void> {
  if (!client.registration_client_uri || !client.registration_access_token) return;
  await fetch(client.registration_client_uri, { method: "DELETE", headers: { Authorization: `Bearer ${client.registration_access_token}` }, signal: timeout() }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------------------------

async function gql<T>(access: RailwayAccess, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (access.method === "token") headers["Project-Access-Token"] = access.token;
  else headers.Authorization = `Bearer ${access.token}`;
  const res = await fetch(`${BACKBOARD}/graphql/v2`, { method: "POST", headers, body: JSON.stringify({ query, variables }), signal: timeout() }).catch(() => null);
  if (!res) throw new RailwayError("Couldn't reach Railway. Crewtavo tries again in a few minutes.");
  if (res.status === 429) throw new RailwayError("Railway asked Crewtavo to slow down. It tries again in a few minutes.", 429);
  // The screen gets words to act on; the log keeps which call Railway refused, and why.
  const refused = (why: string) => {
    console.warn(`Railway refused ${query.match(/\{\s*(\w+)/)?.[1] ?? "a call"}: ${why}`);
    return new RailwayError(lostAccess(access), res.status, true);
  };
  if (res.status === 401 || res.status === 403) throw refused(`HTTP ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  const problem = json.errors?.[0]?.message;
  if (problem && /not authorized/i.test(problem)) throw refused(problem);
  if (problem) throw new RailwayError(`Railway said: ${problem}`, res.status);
  if (!res.ok || !json.data) throw new RailwayError(`Railway answered with an error (${res.status}). Crewtavo tries again in a few minutes.`, res.status);
  return json.data;
}

const lostAccess = (access: RailwayAccess) =>
  access.method === "token"
    ? "Railway didn't accept the project token. Make a new one in the project's Settings → Tokens, for this environment."
    : "Crewtavo's Railway access doesn't reach this project. Log in with Railway again and choose this project.";

/** Checks the access reaches this instance's project, and finds the auth service (redeployed on a switch). */
export async function projectAccess(env: Env, access: RailwayAccess): Promise<{ name: string; authServiceId: string | null }> {
  const { projectId, environmentId } = ids(env);
  if (access.method === "token") {
    const { projectToken } = await gql<{ projectToken: { projectId: string; environmentId: string } }>(access, "query { projectToken { projectId environmentId } }");
    if (projectToken.projectId !== projectId || projectToken.environmentId !== environmentId) {
      throw new RailwayError(`That token is for a different Railway project or environment. Make one in ${env.RAILWAY_PROJECT_NAME ? `the ${env.RAILWAY_PROJECT_NAME} project's` : "this project's"} Settings → Tokens.`);
    }
  }
  const { project } = await gql<{ project: { name: string; services: { edges: { node: { id: string; name: string } }[] } } }>(
    access,
    "query ($id: String!) { project(id: $id) { name services(first: 50) { edges { node { id name } } } } }",
    { id: projectId },
  ).catch((error) => {
    if (error instanceof RailwayError && access.method === "oauth") {
      console.warn(`Railway didn't show Crewtavo its project: ${error.message} (granted: ${access.granted ?? "not said"})`);
      throw new RailwayError(`Crewtavo can't see ${env.RAILWAY_PROJECT_NAME ? `the ${env.RAILWAY_PROJECT_NAME} project` : "this Railway project"}. Log in with Railway again and choose it on Railway's screen.`);
    }
    throw error;
  });
  const auth = project.services.edges.find((e) => e.node.name === "auth");
  return { name: project.name, authServiceId: auth?.node.id ?? null };
}

const DOMAIN_STATUS = `status {
  verified certificateStatus certificateErrorMessage verificationDnsHost verificationToken
  dnsRecords { recordType purpose hostlabel fqdn zone requiredValue status }
}`;

export interface RailwayDomainStatus {
  verified: boolean;
  certificateStatus: string;
  certificateErrorMessage: string | null;
  verificationDnsHost: string | null;
  verificationToken: string | null;
  dnsRecords: { recordType: string; purpose: string; hostlabel: string; fqdn: string; zone: string; requiredValue: string; status: string }[];
}

interface RailwayDomain {
  id: string;
  domain: string;
  status: RailwayDomainStatus;
}

/** The custom domains on the crewtavo service: added by hand, by Crewtavo, or bought from Railway there. */
export async function serviceDomains(env: Env, access: RailwayAccess): Promise<RailwayDomain[]> {
  const { projectId, environmentId, serviceId } = ids(env);
  const { domains } = await gql<{ domains: { customDomains: RailwayDomain[] } }>(
    access,
    `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { customDomains { id domain ${DOMAIN_STATUS} } }
    }`,
    { projectId, environmentId, serviceId },
  );
  return domains.customDomains;
}

/**
 * Adds the domain to the crewtavo service, or finds it there (`added` false) when it already is.
 * Railway's customDomainAvailable isn't asked first: it isn't tied to a project, so a Login with
 * Railway token (access to one project) is refused it. A domain Railway can't use is turned away
 * by customDomainCreate instead, and its answer is passed on below.
 */
export async function addCustomDomain(env: Env, access: RailwayAccess, domain: string): Promise<RailwayDomain & { added: boolean }> {
  const { projectId, environmentId, serviceId } = ids(env);
  const existing = (await serviceDomains(env, access)).find((d) => d.domain === domain);
  if (existing) return { ...existing, added: false };
  const { customDomainCreate } = await gql<{ customDomainCreate: RailwayDomain }>(
    access,
    `mutation ($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id domain ${DOMAIN_STATUS} } }`,
    { input: { projectId, environmentId, serviceId, domain, targetPort: Number(env.PORT ?? 8080) } },
  ).catch((error) => {
    if (!(error instanceof RailwayError)) throw error;
    // The project itself is reachable (checked at sign-in), so this is Railway refusing this one step.
    // Added by hand, the domain is found above next time and Crewtavo carries on from there.
    if (error.denied) {
      throw new RailwayError(`Railway didn't let Crewtavo add ${domain}. Add it in Railway yourself: open the crewtavo service, then Settings → Networking → Custom Domain. Crewtavo picks it up from there and does the rest.`, error.status, true);
    }
    // Only Railway's own answers; "couldn't reach Railway" and the like stay as they are.
    if (!error.message.startsWith("Railway said: ")) throw error;
    const said = error.message.replace(/^Railway said: /, "");
    // Railway's trial allows 1 custom domain and Hobby 2 per service.
    if (/limit|maximum|upgrade/i.test(said)) {
      throw new RailwayError(`Railway's plan for this project doesn't allow another custom domain (${said}). Remove one in Railway, or upgrade the plan, then try again.`);
    }
    throw new RailwayError(`Railway can't use ${domain}: ${said}`, error.status);
  });
  return { ...customDomainCreate, added: true };
}

export async function customDomainStatus(env: Env, access: RailwayAccess, id: string): Promise<RailwayDomain> {
  const { customDomain } = await gql<{ customDomain: RailwayDomain }>(
    access,
    `query ($id: String!, $projectId: String!) { customDomain(id: $id, projectId: $projectId) { id domain ${DOMAIN_STATUS} } }`,
    { id, projectId: ids(env).projectId },
  );
  return customDomain;
}

export async function deleteCustomDomain(access: RailwayAccess, id: string): Promise<void> {
  await gql(access, "mutation ($id: String!) { customDomainDelete(id: $id) }", { id });
}

/** Sets a variable on the crewtavo service without deploying; redeploy() then starts it with the new value. */
export async function setVariable(env: Env, access: RailwayAccess, name: string, value: string): Promise<void> {
  await setServiceVariable(env, access, ids(env).serviceId, name, value);
}

/** Sets a variable on one of the project's services without deploying it. */
export async function setServiceVariable(env: Env, access: RailwayAccess, serviceId: string, name: string, value: string): Promise<void> {
  const { projectId, environmentId } = ids(env);
  await gql(access, "mutation ($input: VariableUpsertInput!) { variableUpsert(input: $input) }", {
    input: { projectId, environmentId, serviceId, name, value, skipDeploys: true },
  });
}

/** Sets several of a service's variables in one change, without deploying it (redeploy() starts it with them). Others stay as they are. */
export async function setServiceVariables(env: Env, access: RailwayAccess, serviceId: string, variables: Record<string, string>): Promise<void> {
  const { projectId, environmentId } = ids(env);
  await gql(access, "mutation ($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }", {
    input: { projectId, environmentId, serviceId, variables, skipDeploys: true },
  });
}

/** Another service in this instance's project, by the name the template gives it ("storage"). */
export async function serviceIdByName(env: Env, access: RailwayAccess, name: string): Promise<string | null> {
  const { project } = await gql<{ project: { services: { edges: { node: { id: string; name: string } }[] } } }>(
    access,
    "query ($id: String!) { project(id: $id) { services(first: 50) { edges { node { id name } } } } }",
    { id: ids(env).projectId },
  );
  return project.services.edges.find((e) => e.node.name === name)?.node.id ?? null;
}

/** A service's variables in this environment, as name → value. */
export async function serviceVariables(env: Env, access: RailwayAccess, serviceId: string): Promise<Record<string, string>> {
  const { projectId, environmentId } = ids(env);
  const { variables } = await gql<{ variables: Record<string, string> | null }>(
    access,
    "query ($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }",
    { projectId, environmentId, serviceId },
  );
  return variables ?? {};
}

export async function redeploy(env: Env, access: RailwayAccess, serviceId: string): Promise<void> {
  await gql(access, "mutation ($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }", {
    environmentId: ids(env).environmentId,
    serviceId,
  });
}

export const crewtavoServiceId = (env: Env) => ids(env).serviceId;

// ---------------------------------------------------------------------------------------------
// Usage (Settings → Hosting). These queries are the ones Railway's own dashboard uses; they aren't
// in Railway's API docs, so services/hosting.ts treats each as optional.
// ---------------------------------------------------------------------------------------------

/**
 * What Railway bills by. usage() counts CPU and memory in vCPU- and GB-minutes: priced that way, a
 * trial's usage matched Railway's own "$4.39 left" (2026-10-20). Railway's estimatedUsage isn't a
 * forecast for the month (it came to less than was already used), so services/hosting.ts makes one.
 */
export const BILLED = ["CPU_USAGE", "MEMORY_USAGE_GB", "NETWORK_TX_GB", "DISK_USAGE_GB", "BACKUP_USAGE_GB"] as const;
export type Billed = (typeof BILLED)[number];

export interface RailwayProject {
  name: string;
  /** trial, free, hobby or pro. */
  plan: string | null;
  createdAt: string | null;
  services: { id: string; name: string }[];
}

export async function projectDetails(env: Env, access: RailwayAccess): Promise<RailwayProject> {
  const { project } = await gql<{ project: { name: string; subscriptionType: string | null; createdAt: string | null; services: { edges: { node: { id: string; name: string } }[] } } }>(
    access,
    "query ($id: String!) { project(id: $id) { name subscriptionType createdAt services(first: 50) { edges { node { id name } } } } }",
    { id: ids(env).projectId },
  );
  return { name: project.name, plan: project.subscriptionType, createdAt: project.createdAt, services: project.services.edges.map((e) => e.node) };
}

/** This project's usage between two times, per service. */
export async function projectUsage(env: Env, access: RailwayAccess, start: Date, end: Date): Promise<Array<{ measurement: Billed; serviceId: string | null; value: number }>> {
  const { usage } = await gql<{ usage: Array<{ measurement: Billed; value: number; tags: { serviceId: string | null } }> }>(
    access,
    `query ($projectId: String!, $start: DateTime!, $end: DateTime!, $measurements: [MetricMeasurement!]!) {
      usage(projectId: $projectId, startDate: $start, endDate: $end, measurements: $measurements, groupBy: [SERVICE_ID]) { measurement value tags { serviceId } }
    }`,
    { projectId: ids(env).projectId, start: start.toISOString(), end: end.toISOString(), measurements: BILLED },
  );
  return usage.map((u) => ({ measurement: u.measurement, serviceId: u.tags?.serviceId ?? null, value: u.value }));
}

export const projectIdOf = (env: Env) => ids(env).projectId;

/** Memory (GB) and CPU (vCPUs) per service since `start`, a sample every `stepSeconds`. */
export async function usageMetrics(env: Env, access: RailwayAccess, start: Date, stepSeconds: number): Promise<Array<{ measurement: "MEMORY_USAGE_GB" | "CPU_USAGE"; serviceId: string | null; values: { ts: number; value: number }[] }>> {
  const { projectId, environmentId } = ids(env);
  const { metrics } = await gql<{ metrics: Array<{ measurement: "MEMORY_USAGE_GB" | "CPU_USAGE"; tags: { serviceId: string | null }; values: { ts: number; value: number }[] }> }>(
    access,
    `query ($projectId: String!, $environmentId: String!, $start: DateTime!, $step: Int!) {
      metrics(projectId: $projectId, environmentId: $environmentId, startDate: $start, measurements: [MEMORY_USAGE_GB, CPU_USAGE], groupBy: [SERVICE_ID], sampleRateSeconds: $step, averagingWindowSeconds: $step) {
        measurement tags { serviceId } values { ts value }
      }
    }`,
    { projectId, environmentId, start: start.toISOString(), step: stepSeconds },
  );
  return metrics.map((m) => ({ measurement: m.measurement, serviceId: m.tags?.serviceId ?? null, values: m.values }));
}

/** The volumes in Crewtavo's environment: how full each is. */
export async function volumeSizes(env: Env, access: RailwayAccess): Promise<Array<{ serviceId: string | null; usedMb: number; sizeMb: number }>> {
  const { projectId, environmentId } = ids(env);
  const { environment } = await gql<{ environment: { volumeInstances: { edges: { node: { serviceId: string | null; currentSizeMB: number | null; sizeMB: number | null } }[] } } }>(
    access,
    "query ($id: String!, $projectId: String!) { environment(id: $id, projectId: $projectId) { volumeInstances { edges { node { serviceId currentSizeMB sizeMB } } } } }",
    { id: environmentId, projectId },
  );
  return environment.volumeInstances.edges
    .map((e) => e.node)
    .filter((v) => v.sizeMB)
    .map((v) => ({ serviceId: v.serviceId, usedMb: v.currentSizeMB ?? 0, sizeMb: v.sizeMB ?? 0 }));
}

// ---------------------------------------------------------------------------------------------
// Storage buckets (Settings → Hosting: what they hold, and moving files into one; see
// services/storageBucket.ts). A bucket is made in the project, then put in this environment, the
// way Railway's own CLI does it (`railway bucket create`). These come from Railway's schema and
// CLI rather than its API docs, and whether a project's sign-in may make one isn't documented, so
// callers turn a refusal into steps for the owner to do in Railway.
// ---------------------------------------------------------------------------------------------

export interface RailwayBucket {
  id: string;
  name: string;
}

/** The project's buckets, in any environment. */
export async function projectBuckets(env: Env, access: RailwayAccess): Promise<RailwayBucket[]> {
  const { project } = await gql<{ project: { buckets?: { edges: { node: RailwayBucket }[] } | null } }>(
    access,
    "query ($id: String!) { project(id: $id) { buckets(first: 50) { edges { node { id name } } } } }",
    { id: ids(env).projectId },
  );
  return project.buckets?.edges.map((e) => e.node) ?? [];
}

/** Railway's answer for a bucket that isn't in this environment (never deployed here, or not yet). */
const notHere = <T>(error: unknown): T | null => {
  if (error instanceof RailwayError && /BucketInstance not found/i.test(error.message)) return null;
  throw error;
};

/** What a bucket holds in this environment; null when it isn't in this environment. */
export async function bucketUsage(env: Env, access: RailwayAccess, bucketId: string): Promise<{ sizeBytes: number; objects: number } | null> {
  // Both are BigInts, which come as strings once they're large.
  const data = await gql<{ bucketInstanceDetails: { sizeBytes: number | string; objectCount: number | string } | null }>(
    access,
    "query ($bucketId: String!, $environmentId: String!) { bucketInstanceDetails(bucketId: $bucketId, environmentId: $environmentId) { sizeBytes objectCount } }",
    { bucketId, environmentId: ids(env).environmentId },
  ).catch(notHere<{ bucketInstanceDetails: null }>);
  const details = data?.bucketInstanceDetails;
  return details ?{ sizeBytes: Number(details.sizeBytes) || 0, objects: Number(details.objectCount) || 0 } : null;
}

/** Makes a bucket in the project. It isn't in any environment until deployBucket puts it in this one. */
export async function createBucket(env: Env, access: RailwayAccess, name: string): Promise<RailwayBucket> {
  const { bucketCreate } = await gql<{ bucketCreate: RailwayBucket }>(access, "mutation ($input: BucketCreateInput!) { bucketCreate(input: $input) { id name } }", {
    input: { projectId: ids(env).projectId, name },
  });
  return bucketCreate;
}

/**
 * Puts a bucket in this environment, in a region ("sjc", "iad", "ams" or "sin"; Railway picks when
 * it's null). Railway applies it straight away, unless someone has changes waiting in the
 * environment: then it's added to those ("staged"), the way Railway's CLI does, so nobody's pending
 * edits go live with it, and the owner deploys them all in Railway.
 */
export async function deployBucket(env: Env, access: RailwayAccess, bucketId: string, region: string | null): Promise<"deployed" | "staged"> {
  const { projectId, environmentId } = ids(env);
  const waiting = await gql<{ environment: { unmergedChangesCount: number | null } }>(
    access,
    "query ($id: String!, $projectId: String!) { environment(id: $id, projectId: $projectId) { unmergedChangesCount } }",
    { id: environmentId, projectId },
  ).then(
    (data) => data.environment.unmergedChangesCount ?? 0,
    // Not knowing whether someone has changes waiting: add to them rather than deploy them.
    (error) => {
      if (error instanceof RailwayError && error.denied) throw error;
      return 1;
    },
  );
  const patch = { buckets: { [bucketId]: { ...(region ? { region } : {}), isCreated: true } } };
  if (waiting > 0) {
    await gql(access, "mutation ($environmentId: String!, $input: EnvironmentConfig!) { environmentStageChanges(environmentId: $environmentId, input: $input, merge: true) { id } }", {
      environmentId,
      input: patch,
    });
    return "staged";
  }
  await gql(access, "mutation ($environmentId: String!, $patch: EnvironmentConfig, $message: String) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $message) }", {
    environmentId,
    patch,
    message: "Crewtavo: a bucket for photos and files",
  });
  return "deployed";
}

/** A bucket's S3 address and keys in this environment. `urlStyle` says whether its address takes the bucket in the path. */
export interface BucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  /** The bucket's name at S3 (globally unique, like "files-a1b2c3"), not the name it has in the project. */
  bucketName: string;
  region: string;
  urlStyle: string;
}

/** Null until the bucket is in this environment. */
export async function bucketCredentials(env: Env, access: RailwayAccess, bucketId: string): Promise<BucketCredentials | null> {
  const { projectId, environmentId } = ids(env);
  const data = await gql<{ bucketS3Credentials: BucketCredentials[] | null }>(
    access,
    "query ($projectId: String!, $environmentId: String!, $bucketId: String!) { bucketS3Credentials(projectId: $projectId, environmentId: $environmentId, bucketId: $bucketId) { accessKeyId secretAccessKey endpoint bucketName region urlStyle } }",
    { projectId, environmentId, bucketId },
  ).catch(notHere<{ bucketS3Credentials: null }>);
  return data?.bucketS3Credentials?.[0] ?? null;
}

/**
 * Where a service runs in this environment, like "iad" or "us-east4-eqdc4a"; null when Railway
 * doesn't say. Railway now leaves `region` empty and keeps it in the deployment's multiRegionConfig.
 */
export async function serviceRegion(env: Env, access: RailwayAccess, serviceId: string): Promise<string | null> {
  type Deploy = { region?: string | null; multiRegionConfig?: Record<string, unknown> | null };
  const { serviceInstance } = await gql<{ serviceInstance: { region: string | null; latestDeployment: { meta: { serviceManifest?: { deploy?: Deploy } } | null } | null } | null }>(
    access,
    "query ($environmentId: String!, $serviceId: String!) { serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { region latestDeployment { meta } } }",
    { environmentId: ids(env).environmentId, serviceId },
  );
  const deploy = serviceInstance?.latestDeployment?.meta?.serviceManifest?.deploy;
  return serviceInstance?.region || deploy?.region || Object.keys(deploy?.multiRegionConfig ?? {})[0] || null;
}

/** This project's page on Railway, in this environment, or one of a service's tabs there. */
export function railwayPage(env: Env, service?: { id: string; tab: "variables" | "settings" | "deployments" }): string | null {
  const found = railwayIds(env);
  if (!found) return null;
  const base = `https://railway.com/project/${found.projectId}`;
  return service ? `${base}/service/${service.id}/${service.tab}?environmentId=${found.environmentId}` : `${base}?environmentId=${found.environmentId}`;
}

// ---------------------------------------------------------------------------------------------
// From Railway's status to what the owner sees
// ---------------------------------------------------------------------------------------------

const RECORD_TYPES: Record<string, WantedRecord["type"]> = { DNS_RECORD_TYPE_CNAME: "CNAME", DNS_RECORD_TYPE_TXT: "TXT", DNS_RECORD_TYPE_A: "A" };

/** The records Railway wants, each with whether Railway already sees it. */
export function railwayRecords(domain: string, status: RailwayDomainStatus, zoneHint: string | null): Array<WantedRecord & { ok: boolean }> {
  const records: Array<WantedRecord & { ok: boolean }> = [];
  const zone: string | null = status.dnsRecords.find((r) => r.zone)?.zone ?? zoneHint;
  for (const r of status.dnsRecords) {
    const type = RECORD_TYPES[r.recordType];
    if (!type) continue;
    records.push({
      type,
      purpose: r.purpose === "DNS_RECORD_PURPOSE_ACME_DNS01_CHALLENGE" ? "verify" : "route",
      name: r.fqdn || domain,
      host: r.hostlabel || "@",
      value: r.requiredValue,
      ok: r.status === "DNS_RECORD_STATUS_PROPAGATED",
    });
  }
  // The TXT record proving the domain is the owner's comes separately.
  if (status.verificationDnsHost && status.verificationToken) {
    const host = status.verificationDnsHost.replace(/\.$/, "");
    const name = zone && !host.endsWith(zone) ? `${host}.${zone}` : host;
    records.push({ type: "TXT", purpose: "verify", name, host: zone && name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : host, value: status.verificationToken, ok: status.verified });
  }
  return records;
}

export function certificateOf(status: RailwayDomainStatus): "pending" | "issued" | "failed" {
  if (status.certificateStatus === "CERTIFICATE_STATUS_TYPE_VALID") return "issued";
  if (status.certificateStatus === "CERTIFICATE_STATUS_TYPE_ISSUE_FAILED") return "failed";
  return "pending";
}
