const { Pool, types } = require('pg');

const TAG = '^5[postgres]^7';
const TAG_ERROR = '^1[postgres]^7';
const RETRY_MS = 5000;

const log = (msg) => console.log(`${TAG} ${msg}`);
const logError = (msg) => console.log(`${TAG_ERROR} ${msg}`);

let unsafeLogged = false;
types.setTypeParser(20, (v) => {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) && !unsafeLogged) {
    unsafeLogged = true;
    logError(`bigint above 2^53 was rounded: ${v}`);
  }
  return n;
});
types.setTypeParser(1114, (v) => (v === null ? null : Date.parse(v + 'Z')));
types.setTypeParser(1184, (v) => (v === null ? null : Date.parse(v)));
types.setTypeParser(1082, (v) => v);

const convar = (name, fallback) => GetConvar(name, fallback);
const convarNumber = (name, fallback) => Number(convar(name, String(fallback)));

const slowMs = () => convarNumber('pg_slow_ms', 150);
const readyTimeoutMs = () => convarNumber('pg_ready_timeout', 120000);

let loopLagMs = 0;
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  loopLagMs = Math.max(0, now - lastTick - 1000);
  lastTick = now;
}, 1000);

let queryCount = 0;
let slowCount = 0;
let pool = null;
let ready = false;
let waiters = [];
let attempts = 0;

function settle(ok) {
  ready = ok;
  const list = waiters;
  waiters = [];
  for (const fn of list) fn(ok);
}

function probe() {
  if (!pool) return;
  pool
    .query('select version()')
    .then((res) => {
      const retry = attempts > 0 ? ` (attempt ${attempts + 1})` : '';
      log(`connected${retry}: ${res.rows[0].version.split(',')[0]}`);
      settle(true);
    })
    .catch((err) => {
      if (attempts % 6 === 0) logError(`cannot connect (attempt ${attempts + 1}): ${err.message}`);
      attempts += 1;
      setTimeout(probe, RETRY_MS);
    });
}

function start() {
  attempts = 0;
  const url = convar('pg_url', '');
  if (!url) {
    logError('missing convar `pg_url`, e.g. set pg_url "postgres://user:pass@127.0.0.1:5432/db"');
    return;
  }
  pool = new Pool({
    connectionString: url,
    max: convarNumber('pg_pool_max', 20),
    idleTimeoutMillis: 0,
    keepAlive: true,
    connectionTimeoutMillis: convarNumber('pg_connect_timeout', 15000),
    statement_timeout: convarNumber('pg_statement_timeout', 30000),
  });
  pool.on('error', (err) => logError(`idle client error: ${err.message}`));
  probe();
}

function stop() {
  if (!pool) return;
  pool.end().catch(() => {});
  pool = null;
  ready = false;
}

module.exports = {
  log,
  logError,
  start,
  stop,
  slowMs,
  readyTimeoutMs,
  pool: () => pool,
  loopLag: () => loopLagMs,
  isReady: () => ready,
  onReady: (fn) => waiters.push(fn),
  countQuery: (slow) => {
    queryCount += 1;
    if (slow) slowCount += 1;
  },
  counters: () => ({ queries: queryCount, slow: slowCount, loopLagMs }),
};
