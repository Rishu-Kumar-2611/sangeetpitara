/**
 * Browser-side adapter for RoomSound's cookie-backed account API.
 *
 * The server intentionally keeps the session token in an HttpOnly cookie. This
 * module only returns the public user object and never exposes or stores a
 * token in browser JavaScript.
 */

export const AUTH_PATHS = Object.freeze({
  login: '/api/auth/login',
  register: '/api/auth/register',
  me: '/api/auth/me',
  logout: '/api/auth/logout',
});

export class AuthRequestError extends Error {
  constructor(message, { status = 0, code = '', field = '' } = {}) {
    super(message);
    this.name = 'AuthRequestError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

function responseMessage(payload, status, fallback) {
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
  if (status === 401) return 'Sign in is required.';
  if (status === 429) return 'Too many attempts. Try again later.';
  return fallback;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function requestAuth(path, {
  method = 'GET',
  body,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new AuthRequestError('Account access is unavailable in this browser.');

  const headers = { Accept: 'application/json' };
  const init = {
    method,
    credentials: 'same-origin',
    headers,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    throw new AuthRequestError('Account access is temporarily unavailable.');
  }

  const payload = await readJson(response);
  if (!response.ok) {
    throw new AuthRequestError(responseMessage(payload, response.status, 'Account request could not be completed.'), {
      status: response.status,
      code: typeof payload?.code === 'string' ? payload.code : '',
      field: typeof payload?.field === 'string' ? payload.field : '',
    });
  }
  return payload;
}

export async function getCurrentUser(fetchImpl = globalThis.fetch) {
  try {
    const payload = await requestAuth(AUTH_PATHS.me, { fetchImpl });
    return payload?.user || null;
  } catch (error) {
    if (error?.status === 401) return null;
    throw error;
  }
}

export function submitAuth(mode, credentials, fetchImpl = globalThis.fetch) {
  const path = AUTH_PATHS[mode];
  if (!path || (mode !== 'login' && mode !== 'register')) {
    throw new TypeError('Unsupported account operation.');
  }
  return requestAuth(path, {
    method: 'POST',
    body: credentials,
    fetchImpl,
  });
}

export function logout(fetchImpl = globalThis.fetch) {
  return requestAuth(AUTH_PATHS.logout, { method: 'POST', fetchImpl });
}
