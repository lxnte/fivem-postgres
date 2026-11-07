local RESOURCE = 'fivem-postgres'
local Await = Citizen.Await
local LoadResourceFile = LoadResourceFile
local tostring, tonumber, pcall, print, setmetatable = tostring, tonumber, pcall, print, setmetatable

local function shorten(sql)
    local text = tostring(sql):gsub('%s+', ' ')
    return #text > 160 and text:sub(1, 160) .. '...' or text
end

local function settler(p, what)
    local done = false
    return function(result, err)
        if done then return end
        done = true
        local ok, failure = pcall(function()
            if err then
                p:reject(err)
            else
                p:resolve(result)
            end
        end)
        if not ok then print(('^1[postgres] reply not delivered: %s^7  %s'):format(tostring(failure), what)) end
    end
end

local proxy, methods = nil, {}

AddEventHandler('onResourceStop', function(name)
    if name == RESOURCE then
        proxy, methods = nil, {}
    end
end)

local function call(method, ...)
    local fn = methods[method]
    if not fn then
        proxy = proxy or exports[RESOURCE]
        fn = proxy[method]
        methods[method] = fn
    end
    return fn(proxy, ...)
end

local function await(method, what, ...)
    local p = promise.new()
    local args = { ... }
    args[#args + 1] = settler(p, what)
    call(method, table.unpack(args))
    return Await(p)
end

local function build(method)
    return setmetatable({
        await = function(sql, params)
            return await(method, shorten(sql), sql, params or {})
        end,
    }, {
        __call = function(_, sql, params, cb)
            if cb == nil then return await(method, shorten(sql), sql, params or {}) end
            return call(method, sql, params or {}, cb)
        end,
    })
end

Db = {
    NULL = '\1pgnull\1',
    query = build('query'),
    single = build('single'),
    scalar = build('scalar'),
    execute = build('execute'),
}

Db.transaction = setmetatable({
    await = function(queries)
        return await('transaction', 'transaction', queries)
    end,
}, {
    __call = function(self, queries, cb)
        if cb == nil then return self.await(queries) end
        return call('transaction', queries, cb)
    end,
})

function Db.ready()
    local p = promise.new()
    local settle = settler(p, 'ready')
    call('ready', function(ok, err)
        settle(ok and true or false, err)
    end)
    return Await(p)
end

function Db.counters()
    return await('counters', 'counters')
end

function Db.hashPassword(password)
    return await('hashPassword', 'hashPassword', password)
end

function Db.verifyPassword(password, stored)
    return await('verifyPassword', 'verifyPassword', password, stored) == true
end

function Db.randomToken()
    return call('randomToken')
end

function Db.hmac(key, data)
    return call('hmac', key, data)
end

local CREATE = [[
create table if not exists schema_migrations (
    version int primary key,
    name text not null,
    applied_at timestamptz not null default now()
)]]
local RECORD = 'insert into schema_migrations (version, name) values ($1, $2)'

local function applied()
    local done = {}
    local rows = Db.query('select version from schema_migrations')
    for i = 1, #rows do
        done[rows[i].version] = true
    end
    return done
end

local function versionOf(name)
    local version = tonumber(name:match('^(%d+)_'))
    if not version then error(('[postgres] bad migration name: %s'):format(name), 0) end
    return version
end

local function apply(resource, folder, name)
    local sql = LoadResourceFile(resource, ('%s/%s.sql'):format(folder, name))
    if not sql or sql == '' then error(('[postgres] missing file: %s/%s.sql'):format(folder, name), 0) end
    Db.transaction({
        { sql = sql },
        { sql = RECORD, params = { versionOf(name), name } },
    })
    print(('^5[postgres]^7 applied %s'):format(name))
end

function Db.migrate(list, folder)
    local resource = GetCurrentResourceName()
    folder = folder or 'sql'
    Db.execute(CREATE)
    local done = applied()
    local count = 0
    for i = 1, #list do
        local name = list[i]
        if not done[versionOf(name)] then
            apply(resource, folder, name)
            count = count + 1
        end
    end
    return count
end
