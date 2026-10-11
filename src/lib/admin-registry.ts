import { getAdminEmail, isAdminEmail } from './google-auth';

export const ADMIN_REGISTRY_SETTING_KEY = 'kinova_admin_user_registry';

export interface RegisteredUser {
  email: string;
  name: string;
  picture?: string;
  role: 'admin' | 'user';
  status: 'active' | 'blocked';
  firstSeenAt: string;
  lastActiveAt: string;
  loginCount: number;
  aiCallCount: number;
  spreadsheetId?: string;
  invoicesFolderId?: string;
  backupsFolderId?: string;
  refreshToken?: string;
  blockedAt?: string;
  blockedReason?: string;
}

export type PublicRegisteredUser = Omit<RegisteredUser, 'refreshToken'>;

interface RegistryCache {
  users: Record<string, RegisteredUser>;
  fetchedAt: number;
}

let memoryRegistryCache: RegistryCache | null = null;
const CACHE_TTL_MS = 15_000;

export function getAdminAppsScriptEndpoint(): { targetUrl: string; apiKey: string } | null {
  const targetUrl = (
    process.env.APPS_SCRIPT_URL ||
    process.env.ADMIN_APPS_SCRIPT_URL ||
    process.env.NEXT_PUBLIC_APPS_SCRIPT_URL ||
    ''
  ).trim();

  const apiKey = (
    process.env.APPS_SCRIPT_API_KEY ||
    process.env.ADMIN_APPS_SCRIPT_API_KEY ||
    process.env.NEXT_PUBLIC_APPS_SCRIPT_API_KEY ||
    ''
  ).trim();

  if (!targetUrl || !targetUrl.startsWith('https://script.google.com/macros/s/')) {
    return null;
  }

  return { targetUrl, apiKey };
}

async function fetchAdminAppsScript(
  method: 'GET' | 'POST',
  action: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const endpoint = getAdminAppsScriptEndpoint();
  if (!endpoint) return null;

  const { targetUrl, apiKey } = endpoint;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const url = new URL(targetUrl);
    if (apiKey) {
      url.searchParams.set('apiKey', apiKey);
    }

    if (method === 'GET') {
      url.searchParams.set('action', action);
      if (apiKey) url.searchParams.set('key', apiKey);
      url.searchParams.set('_t', String(Date.now()));
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) url.searchParams.set(k, String(v));
      });
      const res = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) return null;
      return await res.json();
    } else {
      const payload = {
        key: apiKey,
        ...params,
        action,
        apiKey,
      };
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) return null;
      return await res.json();
    }
  } catch (err) {
    console.warn(`[AdminRegistry] Failed ${action}:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getAdminUserRegistry(forceFresh = false): Promise<Record<string, RegisteredUser>> {
  const now = Date.now();
  if (!forceFresh && memoryRegistryCache && now - memoryRegistryCache.fetchedAt < CACHE_TTL_MS) {
    return memoryRegistryCache.users;
  }

  const res = (await fetchAdminAppsScript('GET', 'getSettings')) as {
    success?: boolean;
    data?: Record<string, string>;
  } | null;

  let users: Record<string, RegisteredUser> = memoryRegistryCache?.users
    ? { ...memoryRegistryCache.users }
    : {};

  if (res?.success && res.data && res.data[ADMIN_REGISTRY_SETTING_KEY]) {
    try {
      const parsed = JSON.parse(String(res.data[ADMIN_REGISTRY_SETTING_KEY]));
      if (parsed && typeof parsed === 'object') {
        users = parsed as Record<string, RegisteredUser>;
      }
    } catch {
      // Ignore malformed JSON and start clean
    }
  }

  // Always ensure admin email has admin role if present
  const adminEmail = getAdminEmail();
  if (users[adminEmail]) {
    users[adminEmail].role = 'admin';
    users[adminEmail].status = 'active';
  }

  memoryRegistryCache = {
    users,
    fetchedAt: now,
  };

  return users;
}

async function saveAdminUserRegistry(users: Record<string, RegisteredUser>): Promise<boolean> {
  memoryRegistryCache = {
    users: { ...users },
    fetchedAt: Date.now(),
  };

  const serialized = JSON.stringify(users);
  const res = (await fetchAdminAppsScript('POST', 'updateSettings', {
    key: ADMIN_REGISTRY_SETTING_KEY,
    value: serialized,
    mutationId: `admin_reg_${Date.now()}`,
  })) as { success?: boolean } | null;

  return Boolean(res?.success);
}

export async function recordUserLogin(input: {
  email: string;
  name: string;
  picture?: string;
  refreshToken?: string;
  spreadsheetId?: string;
  invoicesFolderId?: string;
  backupsFolderId?: string;
}): Promise<RegisteredUser> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const users = await getAdminUserRegistry(true);
  const nowIso = new Date().toISOString();
  const existing = users[normalizedEmail];
  const isAdmin = isAdminEmail(normalizedEmail);

  const updated: RegisteredUser = {
    email: normalizedEmail,
    name: input.name || existing?.name || normalizedEmail.split('@')[0],
    picture: input.picture || existing?.picture,
    role: isAdmin ? 'admin' : 'user',
    status: isAdmin ? 'active' : (existing?.status || 'active'),
    firstSeenAt: existing?.firstSeenAt || nowIso,
    lastActiveAt: nowIso,
    loginCount: (existing?.loginCount || 0) + 1,
    aiCallCount: existing?.aiCallCount || 0,
    spreadsheetId: input.spreadsheetId || existing?.spreadsheetId,
    invoicesFolderId: input.invoicesFolderId || existing?.invoicesFolderId,
    backupsFolderId: input.backupsFolderId || existing?.backupsFolderId,
    refreshToken: input.refreshToken || existing?.refreshToken,
    blockedAt: existing?.blockedAt,
    blockedReason: existing?.blockedReason,
  };

  users[normalizedEmail] = updated;
  await saveAdminUserRegistry(users);
  return updated;
}

export async function updateUserDriveIds(
  email: string,
  ids: {
    spreadsheetId?: string;
    invoicesFolderId?: string;
    backupsFolderId?: string;
  }
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const users = await getAdminUserRegistry(false);
  const existing = users[normalizedEmail];
  if (!existing) return;

  let changed = false;
  if (ids.spreadsheetId && existing.spreadsheetId !== ids.spreadsheetId) {
    existing.spreadsheetId = ids.spreadsheetId;
    changed = true;
  }
  if (ids.invoicesFolderId && existing.invoicesFolderId !== ids.invoicesFolderId) {
    existing.invoicesFolderId = ids.invoicesFolderId;
    changed = true;
  }
  if (ids.backupsFolderId && existing.backupsFolderId !== ids.backupsFolderId) {
    existing.backupsFolderId = ids.backupsFolderId;
    changed = true;
  }
  if (changed) {
    users[normalizedEmail] = existing;
    await saveAdminUserRegistry(users);
  }
}

export async function isUserBlocked(email?: string | null): Promise<boolean> {
  if (!email) return false;
  const normalizedEmail = email.trim().toLowerCase();
  if (isAdminEmail(normalizedEmail)) return false;

  const users = await getAdminUserRegistry(false);
  const record = users[normalizedEmail];
  return record?.status === 'blocked';
}

export async function recordUserAiCall(email: string): Promise<{ allowed: boolean }> {
  const normalizedEmail = email.trim().toLowerCase();
  const users = await getAdminUserRegistry(false);
  const existing = users[normalizedEmail];

  if (existing?.status === 'blocked' && !isAdminEmail(normalizedEmail)) {
    return { allowed: false };
  }

  const nowIso = new Date().toISOString();
  const updated: RegisteredUser = existing
    ? {
        ...existing,
        lastActiveAt: nowIso,
        aiCallCount: (existing.aiCallCount || 0) + 1,
      }
    : {
        email: normalizedEmail,
        name: normalizedEmail.split('@')[0],
        role: isAdminEmail(normalizedEmail) ? 'admin' : 'user',
        status: 'active',
        firstSeenAt: nowIso,
        lastActiveAt: nowIso,
        loginCount: 1,
        aiCallCount: 1,
      };

  users[normalizedEmail] = updated;
  // Fire-and-forget write so AI response latency stays minimal
  void saveAdminUserRegistry(users);
  return { allowed: true };
}

export async function setUserBlockStatus(
  targetEmail: string,
  blocked: boolean,
  reason?: string
): Promise<PublicRegisteredUser> {
  const normalizedEmail = targetEmail.trim().toLowerCase();
  if (isAdminEmail(normalizedEmail)) {
    throw new Error('Cannot block the administrator account.');
  }

  const users = await getAdminUserRegistry(true);
  const nowIso = new Date().toISOString();
  const existing = users[normalizedEmail];

  const updated: RegisteredUser = existing
    ? {
        ...existing,
        status: blocked ? 'blocked' : 'active',
        blockedAt: blocked ? nowIso : undefined,
        blockedReason: blocked ? (reason || 'Blocked by administrator') : undefined,
      }
    : {
        email: normalizedEmail,
        name: normalizedEmail.split('@')[0],
        role: 'user',
        status: blocked ? 'blocked' : 'active',
        firstSeenAt: nowIso,
        lastActiveAt: nowIso,
        loginCount: 0,
        aiCallCount: 0,
        blockedAt: blocked ? nowIso : undefined,
        blockedReason: blocked ? (reason || 'Blocked by administrator') : undefined,
      };

  users[normalizedEmail] = updated;
  await saveAdminUserRegistry(users);

  const { refreshToken: _omit, ...publicUser } = updated;
  return publicUser;
}

export async function removeUserFromRegistry(targetEmail: string): Promise<boolean> {
  const normalizedEmail = targetEmail.trim().toLowerCase();
  if (isAdminEmail(normalizedEmail)) {
    throw new Error('Cannot remove the administrator account.');
  }
  const users = await getAdminUserRegistry(true);
  if (!users[normalizedEmail]) return false;
  delete users[normalizedEmail];
  await saveAdminUserRegistry(users);
  return true;
}

export function toPublicUserList(users: Record<string, RegisteredUser>): PublicRegisteredUser[] {
  return Object.values(users)
    .map(({ refreshToken: _omit, ...rest }) => rest)
    .sort((a, b) => {
      if (a.role === 'admin' && b.role !== 'admin') return -1;
      if (b.role === 'admin' && a.role !== 'admin') return 1;
      return String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || ''));
    });
}
