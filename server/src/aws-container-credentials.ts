const ENV_CMDS_FULL_URI = "AWS_CONTAINER_CREDENTIALS_FULL_URI";
const ENV_CMDS_RELATIVE_URI = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI";
const ENV_CMDS_AUTH_TOKEN = "AWS_CONTAINER_AUTHORIZATION_TOKEN";
const CREDENTIAL_REQUEST_TIMEOUT_MS = 1000;
const CREDENTIAL_EXPIRATION_SKEW_MS = 60_000;
const LOCAL_CONTAINER_CREDENTIAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
  accountId?: string;
}

export type AwsCredentialProvider = () => Promise<AwsCredentialIdentity>;

interface ContainerCredentialsResponse {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token: string;
  Expiration: string;
  AccountId?: string;
}

function parseAllowedContainerCredentialsUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${ENV_CMDS_FULL_URI} must be an absolute URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${ENV_CMDS_FULL_URI} must use http or https`);
  }
  if (!LOCAL_CONTAINER_CREDENTIAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`${ENV_CMDS_FULL_URI} must point to localhost or 127.0.0.1`);
  }
  return parsed;
}

function parseContainerCredentialsResponse(value: unknown): ContainerCredentialsResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Container metadata service returned an invalid credentials payload");
  }
  const candidate = value as Partial<Record<keyof ContainerCredentialsResponse, unknown>>;
  if (
    typeof candidate.AccessKeyId !== "string" ||
    typeof candidate.SecretAccessKey !== "string" ||
    typeof candidate.Token !== "string" ||
    typeof candidate.Expiration !== "string"
  ) {
    throw new Error("Container metadata service returned incomplete credentials");
  }
  return {
    AccessKeyId: candidate.AccessKeyId,
    SecretAccessKey: candidate.SecretAccessKey,
    Token: candidate.Token,
    Expiration: candidate.Expiration,
    AccountId: typeof candidate.AccountId === "string" ? candidate.AccountId : undefined,
  };
}

async function fetchContainerCredentials(target: URL, authToken: string | undefined): Promise<AwsCredentialIdentity> {
  if (authToken && /[\r\n]/.test(authToken)) {
    throw new Error(`${ENV_CMDS_AUTH_TOKEN} must not contain line breaks`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CREDENTIAL_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      headers: authToken ? { Authorization: authToken } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Container metadata service returned ${response.status}`);
    }

    const payload = parseContainerCredentialsResponse(await response.json() as unknown);
    const expiration = new Date(payload.Expiration);
    if (!Number.isFinite(expiration.getTime())) {
      throw new Error("Container metadata service returned an invalid credential expiration");
    }

    return {
      accessKeyId: payload.AccessKeyId,
      secretAccessKey: payload.SecretAccessKey,
      sessionToken: payload.Token,
      expiration,
      accountId: payload.AccountId,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createSafeContainerCredentialsProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AwsCredentialProvider | undefined {
  if (env[ENV_CMDS_RELATIVE_URI]?.trim()) return undefined;

  const fullUri = env[ENV_CMDS_FULL_URI]?.trim();
  if (!fullUri) return undefined;

  let target: URL | null = null;
  let cachedCredentials: AwsCredentialIdentity | null = null;
  let cachedExpiresAt = 0;
  let pending: Promise<AwsCredentialIdentity> | null = null;

  return async () => {
    const now = Date.now();
    if (cachedCredentials && cachedExpiresAt > now) return cachedCredentials;
    if (pending) return pending;

    target ??= parseAllowedContainerCredentialsUrl(fullUri);
    pending = fetchContainerCredentials(target, env[ENV_CMDS_AUTH_TOKEN])
      .then((credentials) => {
        const expiration = credentials.expiration?.getTime() ?? 0;
        cachedCredentials = credentials;
        cachedExpiresAt = expiration > 0 ? expiration - CREDENTIAL_EXPIRATION_SKEW_MS : 0;
        return credentials;
      })
      .finally(() => {
        pending = null;
      });

    return pending;
  };
}
