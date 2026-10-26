const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate deployment controls before a production listener is opened. */
export function productionConfigErrors(env = process.env, { appVersion = env.APP_VERSION } = {}) {
  if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'production') return [];
  if (truthy(env.ROOMSOUND_TEST_MODE)) return [];

  const errors = [];
  if (!nonEmpty(env.DATABASE_URL)) errors.push('DATABASE_URL must be configured in production.');

  const origins = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origins.length) {
    errors.push('ALLOWED_ORIGINS must contain the exact HTTPS browser origin in production.');
  } else if (origins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash;
    } catch {
      return true;
    }
  })) {
    errors.push('ALLOWED_ORIGINS may contain only origin-only HTTPS URLs in production.');
  }

  if (String(env.METRICS_BEARER_TOKEN || '').trim().length < 32) {
    errors.push('METRICS_BEARER_TOKEN must be at least 32 characters in production.');
  }
  if (!truthy(env.SESSION_COOKIE_SECURE)) errors.push('SESSION_COOKIE_SECURE must be enabled in production.');
  if (!truthy(env.TRUST_PROXY)) errors.push('TRUST_PROXY must be enabled behind the production TLS proxy.');
  if (!SEMVER_PATTERN.test(String(appVersion || '').trim())) errors.push('APP_VERSION must be a semantic version such as 1.1.2.');
  return errors;
}

export function assertProductionConfig(env = process.env, options = {}) {
  const errors = productionConfigErrors(env, options);
  if (errors.length) throw new Error(`Production configuration is unsafe:\n- ${errors.join('\n- ')}`);
}

export { SEMVER_PATTERN };
