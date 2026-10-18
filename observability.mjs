import { redactSecrets } from './security.mjs';

const LOG_LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50 });
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('clock must return a valid Date or timestamp.');
  return date;
}

function normalizeLevel(level) {
  const normalized = String(level || 'info').toLowerCase();
  if (!(normalized in LOG_LEVELS)) throw new TypeError(`Unknown log level: ${level}`);
  return normalized;
}

export function serializeError(error, depth = 0) {
  if (!(error instanceof Error)) return redactSecrets(error);
  const result = {
    name: error.name || 'Error',
    message: error.message || String(error),
  };
  if (error.code !== undefined) result.code = error.code;
  if (error.stack) result.stack = error.stack;
  if (depth < 2 && error.cause instanceof Error) result.cause = serializeError(error.cause, depth + 1);
  return redactSecrets(result);
}

function normalizedFields(fields) {
  if (fields instanceof Error) return { error: serializeError(fields) };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { details: fields };
  const result = {};
  for (const [key, value] of Object.entries(fields)) result[key] = value instanceof Error ? serializeError(value) : value;
  return result;
}

function writeLine(sink, line, entry) {
  if (typeof sink === 'function') {
    sink(line, entry);
    return;
  }
  if (sink && typeof sink.write === 'function') {
    sink.write(`${line}\n`);
  }
}

/**
 * JSON-lines logger. Every field passes through the shared redactor before a
 * sink sees it, so a logger can safely be wired to stdout in production.
 */
export function createStructuredLogger({
  service = 'roomsound',
  level = process.env.LOG_LEVEL || 'info',
  context = {},
  clock = () => new Date(),
  sink = process.stdout,
  onSinkError = () => {},
} = {}) {
  const minimum = normalizeLevel(level);
  const baseContext = redactSecrets(context);
  if (typeof onSinkError !== 'function') throw new TypeError('onSinkError must be a function.');

  function log(logLevel, message, fields = {}) {
    const normalizedLevel = normalizeLevel(logLevel);
    if (LOG_LEVELS[normalizedLevel] < LOG_LEVELS[minimum]) return null;
    const now = isoNow(clock);
    const safeFields = redactSecrets(normalizedFields(fields));
    const entry = {
      ...baseContext,
      ...safeFields,
      time: now.toISOString(),
      level: normalizedLevel,
      service: String(service),
      message: redactSecrets(String(message ?? '')),
    };
    const line = JSON.stringify(entry);
    try {
      writeLine(sink, line, entry);
    } catch (error) {
      try { onSinkError(error, entry); } catch { /* logging must not break the request path */ }
    }
    return entry;
  }

  return {
    trace: (message, fields) => log('trace', message, fields),
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    log,
    enabled(candidate) {
      const candidateLevel = normalizeLevel(candidate);
      return LOG_LEVELS[candidateLevel] >= LOG_LEVELS[minimum];
    },
    child(childContext = {}) {
      return createStructuredLogger({
        service,
        level: minimum,
        context: { ...baseContext, ...childContext },
        clock,
        sink,
        onSinkError,
      });
    },
  };
}

export const createLogger = createStructuredLogger;

function metricName(name, prefix, type) {
  if (typeof name !== 'string' || !METRIC_NAME.test(name)) throw new TypeError(`Invalid metric name: ${name}`);
  const full = prefix && !name.startsWith(`${prefix}_`) ? `${prefix}_${name}` : name;
  if (type === 'counter' && !full.endsWith('_total')) return `${full}_total`;
  return full;
}

function metricLabels(labels) {
  if (labels === undefined || labels === null) return {};
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new TypeError('Metric labels must be an object.');
  const normalized = {};
  for (const key of Object.keys(labels).sort()) {
    if (!LABEL_NAME.test(key)) throw new TypeError(`Invalid metric label name: ${key}`);
    const value = labels[key];
    if (value === null || value === undefined) throw new TypeError(`Metric label ${key} cannot be null.`);
    const stringValue = String(value);
    if (stringValue.length > 128) throw new TypeError(`Metric label ${key} is too long.`);
    normalized[key] = redactSecrets({ [key]: stringValue })[key];
  }
  return normalized;
}

function labelKey(labels) {
  return JSON.stringify(labels);
}

function escapePrometheus(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelsText(labels) {
  const keys = Object.keys(labels);
  if (!keys.length) return '';
  return `{${keys.map((key) => `${key}="${escapePrometheus(labels[key])}"`).join(',')}}`;
}

/**
 * Small in-process Prometheus registry with bounded label cardinality. It is
 * intentionally dependency-free and suitable for the single Node process.
 */
export function createMetricsRegistry({ prefix = 'roomsound', maxSeries = 1_000 } = {}) {
  if (typeof prefix !== 'string' || (prefix && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix))) throw new TypeError('prefix is invalid.');
  if (!Number.isSafeInteger(maxSeries) || maxSeries < 1) throw new TypeError('maxSeries must be a positive safe integer.');
  const definitions = new Map();
  let seriesCount = 0;

  function ensure(name, type, help = '') {
    const fullName = metricName(name, prefix, type);
    const existing = definitions.get(fullName);
    if (existing) {
      if (existing.type !== type) throw new TypeError(`Metric ${fullName} already has type ${existing.type}.`);
      if (help && !existing.help) existing.help = String(help).replace(/[\r\n]+/g, ' ');
      return existing;
    }
    const definition = { name: fullName, type, help: String(help || '').replace(/[\r\n]+/g, ' '), series: new Map() };
    definitions.set(fullName, definition);
    return definition;
  }

  function series(definition, labels) {
    const normalizedLabels = metricLabels(labels);
    const key = labelKey(normalizedLabels);
    let current = definition.series.get(key);
    if (!current) {
      if (seriesCount >= maxSeries) throw new Error('Metric series limit reached.');
      current = { labels: normalizedLabels, value: 0 };
      definition.series.set(key, current);
      seriesCount += 1;
    }
    return current;
  }

  function increment(name, value = 1, labels = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      labels = value;
      value = 1;
    }
    if (!Number.isFinite(value) || value < 0) throw new TypeError('Counter increment must be a finite non-negative number.');
    const current = series(ensure(name, 'counter'), labels);
    current.value += value;
    return current.value;
  }

  function setGauge(name, value, labels = {}) {
    if (!Number.isFinite(value)) throw new TypeError('Gauge value must be finite.');
    const current = series(ensure(name, 'gauge'), labels);
    current.value = value;
    return current.value;
  }

  function registerCounter(name, help = '') {
    const definition = ensure(name, 'counter', help);
    return {
      inc(value = 1, labels = {}) { return increment(definition.name, value, labels); },
      name: definition.name,
    };
  }

  function registerGauge(name, help = '') {
    const definition = ensure(name, 'gauge', help);
    return {
      set(value, labels = {}) { return setGauge(definition.name, value, labels); },
      name: definition.name,
    };
  }

  function registerHistogram(name, help = '', buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {
    if (!Array.isArray(buckets) || !buckets.length || buckets.some((bucket) => !Number.isFinite(bucket) || bucket <= 0)) throw new TypeError('Histogram buckets must be positive finite numbers.');
    const sortedBuckets = [...new Set(buckets)].sort((a, b) => a - b);
    const definition = ensure(name, 'histogram', help);
    return {
      name: definition.name,
      observe(value, labels = {}) {
        if (!Number.isFinite(value) || value < 0) throw new TypeError('Histogram value must be a finite non-negative number.');
        const current = series(definition, labels);
        if (!current.histogram) current.histogram = { count: 0, sum: 0, buckets: new Map(sortedBuckets.map((bucket) => [bucket, 0])) };
        current.histogram.count += 1;
        current.histogram.sum += value;
        for (const bucket of sortedBuckets) if (value <= bucket) current.histogram.buckets.set(bucket, current.histogram.buckets.get(bucket) + 1);
        return current.histogram.count;
      },
    };
  }

  function snapshot() {
    return {
      metrics: [...definitions.values()].flatMap((definition) => [...definition.series.values()].map((current) => ({
        name: definition.name,
        type: definition.type,
        help: definition.help,
        labels: { ...current.labels },
        value: definition.type === 'histogram'
          ? { count: current.histogram?.count || 0, sum: current.histogram?.sum || 0, buckets: Object.fromEntries(current.histogram?.buckets || []) }
          : current.value,
      }))),
    };
  }

  function renderPrometheus() {
    const lines = [];
    for (const definition of definitions.values()) {
      if (definition.help) lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);
      for (const current of definition.series.values()) {
        const suffix = labelsText(current.labels);
        if (definition.type === 'histogram') {
          const histogram = current.histogram || { count: 0, sum: 0, buckets: new Map() };
          for (const [bucket, count] of histogram.buckets) lines.push(`${definition.name}_bucket${labelsText({ ...current.labels, le: bucket })} ${count}`);
          lines.push(`${definition.name}_bucket${labelsText({ ...current.labels, le: '+Inf' })} ${histogram.count}`);
          lines.push(`${definition.name}_sum${suffix} ${histogram.sum}`);
          lines.push(`${definition.name}_count${suffix} ${histogram.count}`);
        } else {
          lines.push(`${definition.name}${suffix} ${current.value}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  return {
    registerCounter,
    registerGauge,
    registerHistogram,
    counter: registerCounter,
    gauge: registerGauge,
    histogram: registerHistogram,
    increment,
    inc: increment,
    set: setGauge,
    setGauge,
    observe(name, value, labels = {}) {
      return registerHistogram(name).observe(value, labels);
    },
    snapshot,
    renderPrometheus,
    contentType: METRICS_CONTENT_TYPE,
    reset() {
      definitions.clear();
      seriesCount = 0;
    },
  };
}

function safeCheckName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new TypeError(`Invalid readiness check name: ${name}`);
  return name;
}

function uptimeSeconds(startedAt, clock) {
  return Math.max(0, Number(((isoNow(clock).getTime() - startedAt.getTime()) / 1_000).toFixed(3)));
}

/**
 * Liveness/readiness state with bounded, redacted dependency checks. The
 * caller decides the HTTP status (healthResponse/readinessResponse provide
 * the conventional 200/503 pair).
 */
export function createHealthState({
  service = 'roomsound',
  version = '0.0.0',
  clock = () => new Date(),
  ready = false,
  checks = {},
  checkTimeoutMs = 2_000,
} = {}) {
  const startedAt = isoNow(clock);
  if (!Number.isSafeInteger(checkTimeoutMs) || checkTimeoutMs < 1) throw new TypeError('checkTimeoutMs must be a positive safe integer.');
  let readyState = Boolean(ready);
  const checkMap = new Map();

  function registerCheck(name, check) {
    const normalizedName = safeCheckName(name);
    if (typeof check !== 'function') throw new TypeError('readiness check must be a function.');
    checkMap.set(normalizedName, check);
    return () => checkMap.delete(normalizedName);
  }
  for (const [name, check] of Object.entries(checks)) registerCheck(name, check);

  function health() {
    return {
      status: 'ok',
      service: String(service),
      version: String(version),
      timestamp: isoNow(clock).toISOString(),
      uptimeSeconds: uptimeSeconds(startedAt, clock),
    };
  }

  async function runCheck(name, check) {
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => check({ service, now: isoNow(clock) })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('readiness check timeout')), checkTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (result === undefined || result === true) return { ok: true };
      if (result === false) return { ok: false, error: 'CHECK_FAILED' };
      if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
        const { ok, ...details } = result;
        return { ok, ...redactSecrets(details) };
      }
      return { ok: Boolean(result) };
    } catch {
      return { ok: false, error: 'CHECK_FAILED' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function readiness() {
    const results = { application: { ok: readyState } };
    for (const [name, check] of checkMap) results[name] = await runCheck(name, check);
    const isReady = readyState && Object.values(results).every((result) => result.ok === true);
    return {
      status: isReady ? 'ready' : 'not_ready',
      service: String(service),
      version: String(version),
      timestamp: isoNow(clock).toISOString(),
      uptimeSeconds: uptimeSeconds(startedAt, clock),
      checks: results,
    };
  }

  return {
    health,
    getHealth: health,
    readiness,
    getReadiness: readiness,
    async healthResponse() { return { statusCode: 200, body: health() }; },
    async readinessResponse() {
      const body = await readiness();
      return { statusCode: body.status === 'ready' ? 200 : 503, body };
    },
    registerCheck,
    setReady(value = true) { readyState = Boolean(value); return readyState; },
    isReady() { return readyState; },
  };
}
