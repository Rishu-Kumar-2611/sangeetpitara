import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { DuplicateEmailError } from './persistence.mjs';

export const SESSION_COOKIE_NAME = 'roomsound_session';
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 1024;
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export class AuthValidationError extends Error {
  constructor(message, field = undefined) {
    super(message);
    this.name = 'AuthValidationError';
    this.code = 'VALIDATION_ERROR';
    this.status = 400;
    this.field = field;
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password.');
    this.name = 'InvalidCredentialsError';
    this.code = 'INVALID_CREDENTIALS';
    this.status = 401;
  }
}

export class AuthConflictError extends Error {
  constructor() {
    super('An account with that email already exists.');
    this.name = 'AuthConflictError';
    this.code = 'EMAIL_EXISTS';
    this.status = 409;
  }
}

function scryptAsync(password, salt, keyLength = SCRYPT_KEY_LENGTH, options = {}) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new AuthValidationError('Email is required.', 'email');
  const email = value.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new AuthValidationError('Enter a valid email address.', 'email');
  }
  return email;
}

export function validatePassword(value) {
  if (typeof value !== 'string') throw new AuthValidationError('Password is required.', 'password');
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new AuthValidationError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`, 'password');
  }
  if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new AuthValidationError('Password is too long.', 'password');
  }
  if (value.includes('\u0000')) throw new AuthValidationError('Password contains an invalid character.', 'password');
  return value;
}

export function validateCredentials(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AuthValidationError('A JSON object with email and password is required.');
  }
  return {
    email: normalizeEmail(input.email),
    password: validatePassword(input.password),
  };
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derivedKey = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const [algorithm, parameters, saltEncoded, keyEncoded] = encoded.split('$');
  if (algorithm !== 'scrypt' || !parameters || !saltEncoded || !keyEncoded) return null;
  const values = Object.fromEntries(parameters.split(',').map((part) => part.split('=')));
  const N = Number(values.N);
  const r = Number(values.r);
  const p = Number(values.p);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return null;
  try {
    const salt = Buffer.from(saltEncoded, 'base64url');
    const key = Buffer.from(keyEncoded, 'base64url');
    if (salt.length !== SCRYPT_SALT_BYTES || key.length !== SCRYPT_KEY_LENGTH) return null;
    return { salt, key };
  } catch {
    return null;
  }
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string') return false;
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  try {
    const derivedKey = await scryptAsync(password, parsed.salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    });
    return timingSafeEqual(parsed.key, derivedKey);
  } catch {
    return false;
  }
}

export function hashSessionToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    isAdmin: Boolean(user.isAdmin),
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt,
  };
}

function dateFromNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid auth clock.');
  return date;
}

function configuredTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) return DEFAULT_SESSION_TTL_MS;
  return Math.min(Math.floor(ttl), 30 * 24 * 60 * 60 * 1000);
}

function tokenFromGenerator(generator) {
  const token = generator();
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
    throw new Error('Session token generator returned an invalid token.');
  }
  return token;
}

export function createAuthService({
  repository,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  now = () => new Date(),
  tokenGenerator = () => randomBytes(32).toString('base64url'),
  passwordHasher = hashPassword,
  passwordVerifier = verifyPassword,
} = {}) {
  if (!repository) throw new Error('An auth repository is required.');
  const ttl = configuredTtl(sessionTtlMs);

  async function issueSession(userId) {
    const token = tokenFromGenerator(tokenGenerator);
    const createdAt = dateFromNow(now);
    const expiresAt = new Date(createdAt.getTime() + ttl);
    await repository.createSession({
      tokenHash: hashSessionToken(token),
      userId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async function register(input) {
    const { email, password } = validateCredentials(input);
    const existing = await repository.findUserByEmail(email);
    if (existing) throw new AuthConflictError();
    let user;
    try {
      user = await repository.createUser({ email, passwordHash: await passwordHasher(password) });
    } catch (error) {
      if (error instanceof DuplicateEmailError || error?.code === '23505' || error?.code === 'DUPLICATE_EMAIL') {
        throw new AuthConflictError();
      }
      throw error;
    }
    const session = await issueSession(user.id);
    return { user: publicUser(user), ...session };
  }

  async function login(input) {
    const { email, password } = validateCredentials(input);
    const user = await repository.findUserByEmail(email);
    const passwordMatches = user
      ? await passwordVerifier(password, user.passwordHash)
      : await passwordHasher(password).then(() => false);
    if (!user || !passwordMatches) throw new InvalidCredentialsError();
    const session = await issueSession(user.id);
    return { user: publicUser(user), ...session };
  }

  async function logout(token) {
    const tokenHash = hashSessionToken(token);
    if (!tokenHash) return false;
    return repository.deleteSession(tokenHash);
  }

  async function currentUser(token) {
    const tokenHash = hashSessionToken(token);
    if (!tokenHash) return null;
    const session = await repository.findSession(tokenHash);
    if (!session) return null;
    const user = session.user || await repository.findUserById(session.userId);
    return publicUser(user);
  }

  return {
    sessionTtlMs: ttl,
    register,
    login,
    logout,
    currentUser,
    getCurrentUser: currentUser,
  };
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (!key) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue.replace(/^"|"$/g, ''));
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
}

export function sessionTokenFromRequest(request) {
  const cookies = parseCookies(request?.headers?.cookie);
  if (cookies[SESSION_COOKIE_NAME]) return cookies[SESSION_COOKIE_NAME];
  const authorization = request?.headers?.authorization;
  if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '').trim();
  }
  return null;
}

export function serializeSessionCookie(token, {
  maxAgeSeconds,
  secure = false,
  name = SESSION_COOKIE_NAME,
} = {}) {
  const attributes = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (Number.isFinite(maxAgeSeconds)) attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearSessionCookie({ secure = false, name = SESSION_COOKIE_NAME } = {}) {
  return serializeSessionCookie('', { maxAgeSeconds: 0, secure, name }) + '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

export function sessionCookieSecure(env = process.env) {
  if (env.SESSION_COOKIE_SECURE === '1' || env.SESSION_COOKIE_SECURE === 'true') return true;
  if (env.SESSION_COOKIE_SECURE === '0' || env.SESSION_COOKIE_SECURE === 'false') return false;
  return env.NODE_ENV === 'production';
}
