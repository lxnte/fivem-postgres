<p align="center">
  <img src="assets/banner.svg" alt="fivem-postgres" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/PostgreSQL-0e0e0e?style=for-the-badge&logo=postgresql&logoColor=00aaff" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Node_22-0e0e0e?style=for-the-badge&logo=nodedotjs&logoColor=00aaff" alt="Node 22">
  <img src="https://img.shields.io/badge/Lua_5.4-0e0e0e?style=for-the-badge&logo=lua&logoColor=00aaff" alt="Lua 5.4">
  <img src="https://img.shields.io/badge/License-MIT-0e0e0e?style=for-the-badge&labelColor=0e0e0e&color=00aaff" alt="MIT">
</p>

A PostgreSQL driver for FiveM servers. Small and fast, with the details already handled: prepared statements, pooling, transactions, migrations and slow query logs.

### Why

- **Prepared by default.** Every parameterized query becomes a named prepared statement. When a migration changes a table, the cache is rebuilt and the query retried, so you never see `cached plan must not change result type`.
- **Real transactions.** `Db.transaction` runs on one client inside `BEGIN … COMMIT` and rolls back on any error.
- **Migrations built in.** Numbered `.sql` files, applied once each, every file inside its own transaction.
- **Honest slow logs.** A slow query is logged with its time. If the server thread itself is lagging, the log says so, so you don't blame the database for it.
- **Safe across restarts.** Callbacks to a resource that has stopped are dropped, not run against dead state.
- **Sensible types.** `bigint` comes back as a Lua number, timestamps as epoch milliseconds and `date` as `'YYYY-MM-DD'`.
- **Auth helpers.** scrypt password hashing, constant-time verify and random tokens.

### Install

```bash
cd resources/fivem-postgres
npm install --omit=dev
```

```cfg
set pg_url "postgres://user:password@127.0.0.1:5432/database"
ensure fivem-postgres
```

In the resource that uses it:

```lua
server_script '@fivem-postgres/lib.lua'
```

### Usage

```lua
CreateThread(function()
    Db.ready()

    local user = Db.single('select id, cash from users where license = $1', { license })
    local count = Db.scalar('select count(*) from users')
    local rows = Db.query('select * from vehicles where owner = $1', { user.id })

    local paid = Db.execute(
        'update users set cash = cash - $1 where id = $2 and cash >= $1',
        { 500, user.id }
    )
    if paid == 0 then return end

    Db.transaction({
        { sql = 'update users set bank = bank - $1 where id = $2', params = { 100, from } },
        { sql = 'update users set bank = bank + $1 where id = $2', params = { 100, to } },
    })
end)
```

Every call blocks the current thread and returns the result. Pass a callback as the last argument to get it async instead:

```lua
Db.execute('update users set seen_at = now() where id = $1', { id }, function(count, err) end)
```

Use `Db.NULL` to send a real `NULL` inside a parameter list, since Lua tables cannot hold `nil`.

### Migrations

```
my-resource/
  sql/
    0001_users.sql
    0002_vehicles.sql
```

```lua
CreateThread(function()
    Db.ready()
    Db.migrate({ '0001_users', '0002_vehicles' })
end)
```

Applied versions are stored in `schema_migrations`. Add new files at the end of the list and never edit one that has already been applied.

### API

| Call | Returns |
| --- | --- |
| `Db.query(sql, params?)` | all rows |
| `Db.single(sql, params?)` | first row or `nil` |
| `Db.scalar(sql, params?)` | first column of first row or `nil` |
| `Db.execute(sql, params?)` | affected row count |
| `Db.transaction({ { sql, params }, … })` | row count per statement |
| `Db.migrate(list, folder?)` | number of migrations applied |
| `Db.ready()` | `true` once connected (`false` after `pg_ready_timeout`) |
| `Db.counters()` | `{ queries, slow, loopLagMs }` |
| `Db.hashPassword(password)` | `scrypt$salt$hash` |
| `Db.verifyPassword(password, stored)` | `true` / `false` |
| `Db.randomToken()` | 32 random bytes, base64url |
| `Db.hmac(key, data)` | HMAC-SHA256, base64url |

### Convars

| Convar | Default |
| --- | --- |
| `pg_url` | required |
| `pg_pool_max` | `20` |
| `pg_slow_ms` | `150` |
| `pg_statement_timeout` | `30000` |
| `pg_connect_timeout` | `15000` |
| `pg_ready_timeout` | `120000` |

If the database is down at boot, the driver retries every 5 seconds and logs every 30.

<p align="center"><sub>MIT · made by <a href="https://github.com/lxnte">LXNTE</a></sub></p>
