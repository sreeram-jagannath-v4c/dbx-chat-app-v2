/**
 * Works out which of the knowledge agent's volumes the signed-in user can read.
 *
 * Unity Catalog is the source of truth: for each configured volume we try to
 * list it with the USER's own token (on-behalf-of), so grants, group
 * membership and revocations are all respected without any app-side mapping.
 *
 * KNOWLEDGE_VOLUMES lists every volume in the knowledge agent's knowledge
 * base, as `catalog.schema.volume` or `/Volumes/catalog/schema/volume`,
 * comma-separated. When it is unset, scoping is disabled.
 */

export interface KnowledgeScope {
  /** Volume paths (/Volumes/c/s/v) the user can read. */
  allowedVolumes: string[];
  /** Knowledge-base volumes the user cannot read. */
  deniedVolumes: string[];
}

function normalizeVolume(value: string): string {
  const path = value.startsWith('/Volumes/')
    ? value
    : `/Volumes/${value.split('.').join('/')}`;
  return path.replace(/\/+$/, '');
}

export function getKnowledgeVolumes(): string[] {
  const raw = process.env.KNOWLEDGE_VOLUMES ?? '';
  const volumes = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map(normalizeVolume);
  return [...new Set(volumes)];
}

/** Scope for local development, where there is no user token: no restriction. */
export function unrestrictedScope(volumes: string[]): KnowledgeScope {
  return { allowedVolumes: volumes, deniedVolumes: [] };
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

const CACHE_TTL_MS =
  Number(process.env.KNOWLEDGE_ACCESS_TTL_SECONDS ?? 60) * 1000;
const cache = new Map<string, { scope: KnowledgeScope; expiresAt: number }>();

/**
 * Returns true/false when the Files API gives a definitive answer, and
 * undefined on transient failures (which are never cached).
 */
async function canReadVolume(
  host: string,
  volume: string,
  token: string,
): Promise<boolean | undefined> {
  try {
    const response = await fetch(
      `${host}/api/2.0/fs/directories${encodePath(volume)}?page_size=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    await response.body?.cancel();
    if (response.ok) return true;
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      console.warn(
        `[knowledge-access] No access to ${volume} (HTTP ${response.status})`,
      );
      return false;
    }
    console.error(
      `[knowledge-access] Unexpected ${response.status} probing ${volume}`,
    );
    return undefined;
  } catch (error) {
    console.error(`[knowledge-access] Failed probing ${volume}:`, error);
    return undefined;
  }
}

/**
 * Probes every knowledge volume with the user's token. Results are cached
 * briefly per user, so revoking access takes effect within the TTL.
 * Fails closed: a volume that could not be checked counts as denied.
 */
export async function resolveKnowledgeScope(params: {
  userKey: string;
  userToken: string;
  host: string;
  volumes: string[];
}): Promise<KnowledgeScope> {
  const { userKey, userToken, host, volumes } = params;
  const cacheKey = `${userKey}|${volumes.join(',')}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.scope;

  const results = await Promise.all(
    volumes.map((volume) => canReadVolume(host, volume, userToken)),
  );

  const scope: KnowledgeScope = {
    allowedVolumes: volumes.filter((_, i) => results[i] === true),
    deniedVolumes: volumes.filter((_, i) => results[i] !== true),
  };

  console.log(
    `[knowledge-access] user=${userKey} allowed=[${scope.allowedVolumes.join(', ')}] denied=[${scope.deniedVolumes.join(', ')}]`,
  );

  if (results.every((r) => r !== undefined)) {
    cache.set(cacheKey, { scope, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return scope;
}