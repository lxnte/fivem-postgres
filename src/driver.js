const { createHash } = require('crypto');
const db = require('./pool.js');
const secrets = require('./secrets.js');

const { log, logError } = db;

const NULL_MARK = '\u0001pgnull\u0001';
const STATEMENT_CACHE = 1000;
const STALE_PLAN = '0A000';
const epochs = {};
const names = new Map();
let generation = 0;

const oneLine = (sql, max) => String(sql).replace(/\s+/g, ' ').trim().slice(0, max);

function unmark(value) {
  if (value === NULL_MARK) return null;
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString('utf8');
    return text === NULL_MARK ? null : text;
  }
  if (Array.isArray(value)) return value.map(unmark);
  return value;
}

function normalize(params) {
  if (params === null || params === undefined) return [];
  if (Array.isArray(params)) return params.map(unmark);
  if (typeof params === 'object') return Object.values(params).map(unmark);
  return [unmark(params)];
}

function statementName(sql) {
  let name = names.get(sql);
  if (!name) {
    if (names.size >= STATEMENT_CACHE) return null;
    name = 'p' + generation + createHash('sha1').update(sql).digest('hex').slice(0, 20);
    names.set(sql, name);
  }
  return name;
}

function toQuery(sql, values) {
  if (values.length === 0) return { text: sql, values };
  const name = statementName(sql);
  return name ? { name, text: sql, values } : { text: sql, values };
}

function stale(err) {
  if (err.code !== STALE_PLAN) return false;
  generation += 1;
  names.clear();
  log('a table changed shape, prepared statements are rebuilt');
  return true;
}

async function retryStale(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!stale(err)) throw err;
    return fn();
  }
}

function connected() {
  const pool = db.pool();
  if (!pool) throw new Error('driver is not started');
  return pool;
}

async function run(sql, params) {
  const pool = connected();
  const values = normalize(params);
  const started = Date.now();
  try {
    const res = await retryStale(() => pool.query(toQuery(sql, values)));
    const took = Date.now() - started;
    const slow = took >= db.slowMs();
    db.countQuery(slow);
    if (slow) {
      const lag = db.loopLag();
      const blame = lag >= db.slowMs() / 2 ? ` (server thread lagging ${lag}ms, not the database)` : '';
      log(`slow ${took}ms${blame}: ${oneLine(sql, 160)}`);
    }
    return res;
  } catch (err) {
    db.countQuery(false);
    logError(`${err.message}\n  SQL: ${oneLine(sql, 300)}`);
    throw err;
  }
}

async function transactionOnce(queries) {
  const client = await connected().connect();
  try {
    await client.query('BEGIN');
    const counts = [];
    for (const q of normalize(queries)) {
      const res = await client.query(toQuery(q.sql, normalize(q.params)));
      counts.push(res.rowCount ?? 0);
    }
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logError(`transaction rolled back: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

const transaction = (queries) => retryStale(() => transactionOnce(queries));

function waitReady() {
  if (db.isReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    setTimeout(() => finish(false), db.readyTimeoutMs());
    db.onReady(finish);
  });
}

const invoker = () => (typeof GetInvokingResource === 'function' ? GetInvokingResource() : '') || '';

function deferred(cb, what) {
  const owner = invoker();
  const epoch = epochs[owner] || 0;
  return (result, error) => {
    if (owner && (epochs[owner] || 0) !== epoch) return;
    try {
      cb(result, error);
    } catch (err) {
      logError(`callback in \`${owner || '?'}\` threw: ${err.message}\n  ${what}`);
    }
  };
}

function reply(promise, cb, what) {
  if (typeof cb !== 'function') return promise;
  const done = deferred(cb, what);
  promise.then(
    (r) => done(r, null),
    (e) => done(null, e.message)
  );
  return null;
}

const bridge = (fn) => (sql, params, cb) => reply(fn(sql, params), cb, oneLine(sql, 160));

exports('query', bridge(async (sql, params) => (await run(sql, params)).rows));
exports('single', bridge(async (sql, params) => (await run(sql, params)).rows[0] ?? null));
exports(
  'scalar',
  bridge(async (sql, params) => {
    const row = (await run(sql, params)).rows[0];
    return row ? (Object.values(row)[0] ?? null) : null;
  })
);
exports('execute', bridge(async (sql, params) => (await run(sql, params)).rowCount ?? 0));
exports('transaction', (queries, cb) => reply(transaction(queries), cb, 'transaction'));
exports('ready', (cb) => reply(waitReady(), cb, 'ready'));
exports('counters', (cb) => reply(Promise.resolve(db.counters()), cb, 'counters'));
exports('hashPassword', (password, cb) => reply(secrets.hashPassword(password), cb, 'hashPassword'));
exports('verifyPassword', (password, stored, cb) =>
  reply(secrets.verifyPassword(password, stored), cb, 'verifyPassword')
);
exports('randomToken', secrets.randomToken);
exports('hmac', secrets.hmac);

on('onResourceStart', (name) => {
  if (name === GetCurrentResourceName()) db.start();
});

on('onResourceStop', (name) => {
  epochs[name] = (epochs[name] || 0) + 1;
  if (name === GetCurrentResourceName()) db.stop();
});
