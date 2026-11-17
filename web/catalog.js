// Runtime metadata and lazy filtered thread pagination added by the remodex-web fork.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const badRequest = message => Object.assign(new Error(message), { status: 400 });
const backendError = () => Object.assign(new Error('Ungültige Seitennavigation vom Codex-Backend'), { status: 502 });
const nullableString = value => typeof value === 'string' ? value : null;
const own = (object, key) => Object.hasOwn(object || {}, key) ? object[key] : null;

function sanitizeModel(value) {
  const result = {};
  for (const key of ['id', 'model', 'displayName', 'description', 'defaultReasoningEffort', 'defaultServiceTier'])
    result[key] = nullableString(value[key]);
  for (const key of ['hidden', 'isDefault']) result[key] = typeof value[key] === 'boolean' ? value[key] : null;
  result.supportedReasoningEfforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.filter(option => option && typeof option === 'object').map(option => ({
      reasoningEffort: nullableString(option.reasoningEffort), description: nullableString(option.description),
    })) : [];
  result.serviceTiers = Array.isArray(value.serviceTiers)
    ? value.serviceTiers.filter(tier => tier && typeof tier === 'object').map(tier => ({
      id: nullableString(tier.id), name: nullableString(tier.name), description: nullableString(tier.description),
    })) : [];
  return result;
}

function sanitizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['limitId', 'limitName', 'normalModelSlug', 'planType', 'rateLimitReachedType'])
    result[key] = nullableString(value[key]);
  result.spendControlReached = typeof value.spendControlReached === 'boolean' ? value.spendControlReached : null;
  for (const key of ['primary', 'secondary']) {
    const window = value[key];
    result[key] = window && typeof window === 'object' ? {
      usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : null,
      resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
      windowDurationMins: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
    } : null;
  }
  const credits = value.credits;
  result.credits = credits && typeof credits === 'object' ? {
    hasCredits: typeof credits.hasCredits === 'boolean' ? credits.hasCredits : null,
    unlimited: typeof credits.unlimited === 'boolean' ? credits.unlimited : null,
    balance: nullableString(credits.balance),
  } : null;
  const individual = value.individualLimit;
  result.individualLimit = individual && typeof individual === 'object' ? {
    limit: nullableString(individual.limit), used: nullableString(individual.used),
    remainingPercent: Number.isFinite(individual.remainingPercent) ? individual.remainingPercent : null,
    resetsAt: Number.isFinite(individual.resetsAt) ? individual.resetsAt : null,
  } : null;
  return result;
}

export function sanitizeUsage(value) {
  const buckets = own(value, 'rateLimitsByLimitId');
  return {
    rateLimits: sanitizeSnapshot(value?.rateLimits),
    rateLimitsByLimitId: buckets && typeof buckets === 'object' && !Array.isArray(buckets)
      ? Object.fromEntries(Object.entries(buckets).map(([key, snapshot]) => [key, sanitizeSnapshot(snapshot)])) : null,
    ordinaryUsageAllowed: typeof value?.ordinaryUsageAllowed === 'boolean' ? value.ordinaryUsageAllowed : null,
  };
}

export async function readRuntime(bridge) {
  const reads = await Promise.allSettled([
    bridge.call('model/list', {}),
    bridge.call('config/read', { includeLayers: false }),
    bridge.call('account/rateLimits/read', {}),
  ]);
  const [models, config, usage] = reads.map(result => result.status === 'fulfilled' ? result.value : null);
  return {
    models: Array.isArray(models?.data)
      ? models.data.filter(model => model && typeof model === 'object' && !Array.isArray(model)).map(sanitizeModel) : [],
    defaults: {
      model: nullableString(config?.config?.model),
      effort: nullableString(config?.config?.model_reasoning_effort),
      serviceTier: nullableString(config?.config?.service_tier),
    },
    usage: sanitizeUsage(usage),
    availability: { models: reads[0].status === 'fulfilled', defaults: reads[1].status === 'fulfilled', usage: reads[2].status === 'fulfilled' },
  };
}

export function createCatalog({ bridge, projects = [] }) {
  const signingKey = randomBytes(32);
  const sign = payload => createHmac('sha256', signingKey).update(payload).digest();
  const seal = record => {
    const payload = Buffer.from(JSON.stringify(record)).toString('base64url');
    return `${payload}.${sign(payload).toString('base64url')}`;
  };
  const unseal = token => {
    if (token.length > 12000) throw badRequest('Ungültiger Cursor');
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) throw badRequest('Ungültiger Cursor');
    const expected = sign(payload);
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw badRequest('Ungültiger Cursor');
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); }
    catch { throw badRequest('Ungültiger Cursor'); }
  };

  async function readProjects() {
    const known = new Map();
    for (const project of projects) if (typeof project?.path === 'string' && project.path)
      known.set(project.path, { name: typeof project.name === 'string' ? project.name : project.path.split('/').filter(Boolean).at(-1), path: project.path });
    let cursor;
    const seen = new Set();
    do {
      const result = await bridge.call('project/list', { limit: 50, ...(cursor ? { cursor } : {}) });
      for (const project of result.data || []) for (const root of project.roots || []) {
        if (typeof root?.path !== 'string' || !root.path) continue;
        known.set(root.path, { name: project.name || root.path.split('/').filter(Boolean).at(-1), path: root.path, id: project.id });
      }
      cursor = result.nextCursor || null;
      if (cursor && seen.has(cursor)) throw backendError();
      seen.add(cursor);
    } while (cursor);
    return [...known.values()];
  }

  async function listThreads(query, sessionKey) {
    const scope = query.get('scope') || 'project';
    const project = query.get('project') || '';
    if (!['project', 'unassigned', 'other'].includes(scope)) throw badRequest('Ungültiger Chatbereich');
    if (scope !== 'unassigned' && (!project.startsWith('/') || project.includes('\0'))) throw badRequest('Projektpfad erforderlich');
    const token = query.get('cursor');
    const limitText = query.get('limit') || (token ? '5' : '10');
    if (!['5', '10'].includes(limitText)) throw badRequest('Seitengröße muss 5 oder 10 sein');
    const limit = Number(limitText);
    const knownProjects = await readProjects();
    const selectedId = scope !== 'unassigned' ? knownProjects.find(value => value.path === project)?.id : null;
    const roots = scope === 'unassigned' ? knownProjects.map(value => value.path).sort() : [];
    const selectedRoots = selectedId ? knownProjects.filter(value => value.id === selectedId).map(value => value.path).sort() : [project];
    const belongsToSelected = thread => selectedId
      ? thread.projectId === selectedId || (!thread.projectId && selectedRoots.includes(thread.cwd))
      : !thread.projectId && thread.cwd === project;
    const filter = createHash('sha256').update(JSON.stringify([scope, project, selectedId, selectedRoots, roots])).digest('hex');
    let cursor = null;
    if (token) {
      const record = unseal(token);
      if (record.session !== sessionKey || record.filter !== filter || record.v !== 1)
        throw badRequest('Cursor gehört zu einem anderen Chatbereich');
      if (typeof record.cursor !== 'string' || !record.cursor) throw badRequest('Ungültiger Cursor');
      cursor = record.cursor;
    }
    const data = [];
    const seen = new Set([cursor]);
    do {
      const remaining = limit - data.length;
      const result = await bridge.call('thread/list', {
        limit: remaining, sortKey: 'updated_at', sortDirection: 'desc',
        ...(scope === 'project' && !selectedId ? { cwd: project } : {}),
        ...(scope === 'unassigned' ? { projectId: null } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result.data) || result.data.length > remaining) throw backendError();
      for (const thread of result.data) {
        if ((scope === 'project' && belongsToSelected(thread))
          || (scope === 'other' && !belongsToSelected(thread))
          || (scope === 'unassigned' && !thread.projectId && !roots.includes(thread.cwd))) data.push(thread);
      }
      cursor = result.nextCursor || null;
      if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw backendError();
      seen.add(cursor);
    } while (cursor && data.length < limit);
    return { data, nextCursor: cursor ? seal({ v: 1, session: sessionKey, filter, cursor }) : null };
  }

  return { readProjects, listThreads };
}
