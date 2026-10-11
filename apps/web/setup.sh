#!/usr/bin/env bash
#
# Fundraise CRM installer (apps/web). Idempotent: safe to re-run at any point, and re-running
# after a partial failure picks up where it stopped rather than starting over.
#
#   ./setup.sh local     Run on this machine. No Cloudflare account needed.
#   ./setup.sh deploy    Provision D1 + secrets and deploy to Cloudflare Pages.
#   ./setup.sh doctor    Diagnose an install without changing anything.
#
# Non-interactive (for an agent): set ANTHROPIC_API_KEY in the environment and
# nothing will prompt. See AGENTS.md.
set -euo pipefail

cd "$(dirname "$0")"

DB_NAME="fundraise-crm-db"
PORT="${PORT:-4318}"
WRANGLER="npx --yes wrangler@4"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- prerequisites
check_prereqs() {
  bold "Checking prerequisites"
  command -v node >/dev/null || die "node is not installed. Install Node 18+ and re-run."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] || die "Node 18+ required (found $(node -v))."
  ok "node $(node -v)"
  # The app runs on Cloudflare Workers and needs nothing newer. The test suite
  # does: it drives the Worker in-process against node:sqlite, which landed in
  # Node 22. Said here so a passing install with a failing `npm test` is not a
  # mystery.
  [ "$major" -ge 22 ] || warn "node $(node -v): the app is fine, but 'npm test' needs Node 22+ (node:sqlite)"
  # Nothing to install: wrangler runs through npx, and the one browser library
  # (motion) is vendored in public/vendor.
}

# The key is the one thing that cannot be generated or defaulted. Accept it from
# the environment first so an agent never has to drive a prompt; fall back to
# reading an existing .dev.vars, and only then ask a human.
resolve_api_key() {
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo "$ANTHROPIC_API_KEY"; return; fi
  if [ -f .dev.vars ] && grep -q '^ANTHROPIC_API_KEY=' .dev.vars; then
    sed -n 's/^ANTHROPIC_API_KEY=//p' .dev.vars | head -1 | tr -d '"'
    return
  fi
  if [ ! -t 0 ]; then
    die "ANTHROPIC_API_KEY is not set and there is no terminal to prompt on.
     Re-run as: ANTHROPIC_API_KEY=sk-ant-... $0 ${MODE:-local}
     Get a key at https://console.anthropic.com/settings/keys"
  fi
  printf 'Anthropic API key (sk-ant-...): ' >&2
  read -r key
  [ -n "$key" ] || die "No key entered."
  echo "$key"
}

# .dev.vars is a flat KEY=value file with no quoting and no continuations. It is
# rewritten wholesale rather than appended to: appending is how it previously
# ended up with a duplicate key on its own line, which silently broke the
# binding and cost an hour of debugging.
write_dev_vars() {
  local key="$1" secret
  secret="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  if [ -f .dev.vars ] && grep -q '^SESSION_SECRET=' .dev.vars; then
    secret="$(sed -n 's/^SESSION_SECRET=//p' .dev.vars | head -1 | tr -d '"')"
  fi
  umask 077
  printf 'SESSION_SECRET=%s\nSIGNUP_OPEN=false\nANTHROPIC_API_KEY=%s\n' "$secret" "$key" > .dev.vars
  ok ".dev.vars written (0600, session secret preserved across re-runs)"
}

# Anything already listening on the port is almost always a previous run of this
# app. A stale server serving pre-edit code is indistinguishable from a broken
# install until you look, so refuse to start rather than appear to succeed.
check_port() {
  local pid
  pid="$(
    { command -v lsof >/dev/null && lsof -ti tcp:"$PORT" 2>/dev/null; } ||
    { command -v ss   >/dev/null && ss -ltnp 2>/dev/null | sed -n "s/.*:$PORT .*pid=\([0-9]*\).*/\1/p"; } ||
    true
  )"
  [ -z "$pid" ] && { ok "port $PORT free"; return; }
  warn "port $PORT is already in use by pid $pid"
  if [ -t 0 ]; then
    printf '  kill it? [y/N] ' >&2; read -r a
    case "$a" in [yY]*) kill $pid; sleep 2; ok "killed $pid" ;; *) die "Port busy. Re-run with PORT=xxxx" ;; esac
  else
    kill $pid 2>/dev/null && sleep 2 && ok "killed stale process $pid" || die "Port $PORT busy; set PORT=xxxx"
  fi
}

# ------------------------------------------------------- owner + investor seed
#
# Someone has to be `admin`, and /signup deliberately cannot make one: an open
# signup route that hands out the ability to repoint the deploy's API key is a
# billing hole. So the installer creates the first account instead.
#
# Runs only when the database has no users. That check is what makes re-running
# setup safe — without it, a second run would overwrite the owner's password
# hash and lock them out of their own instance.
#
# $1 is "--local" or "--remote".
count_users() {
  $WRANGLER d1 execute "$DB_NAME" $1 --command "SELECT COUNT(*) AS n FROM users" --json 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try{const r=JSON.parse(s);const n=(r[0]||r).results[0].n;process.stdout.write(String(n))}catch(e){process.stdout.write('')}
      })"
}

ensure_owner() {
  local scope="$1" n user display company sql cid
  n="$(count_users "$scope")"
  if [ -z "$n" ]; then warn "could not read the users table; skipping owner setup"; return; fi
  if [ "$n" != "0" ]; then ok "accounts already exist ($n) — leaving them alone"; return; fi

  bold "Creating the owner account"
  user="${OWNER_USER:-}"
  company="${OWNER_COMPANY:-}"
  display="${OWNER_DISPLAY:-}"
  if [ -z "$user" ]; then
    if [ ! -t 0 ]; then
      warn "no OWNER_USER set and nothing to prompt on — create an account yourself with scripts/seed-user.js"
      return
    fi
    printf '  username: ' >&2;     read -r user
    printf '  your name: ' >&2;    read -r display
    printf '  company name: ' >&2; read -r company
  fi
  [ -n "$user" ] || { warn "no username given; skipping"; return; }
  display="${display:-$user}"
  company="${company:-$user}"

  sql="$(mktemp)"
  # The password goes to stderr, which is the terminal — never into the SQL file.
  node scripts/seed-user.js "$user" "$display" "$company" > "$sql"
  $WRANGLER d1 execute "$DB_NAME" $scope --file="$sql" >/dev/null \
    && ok "owner '$user' created (role: admin)" \
    || { rm -f "$sql"; die "Could not create the owner account."; }
  cid="$(grep -oE "co_[a-z0-9]+" "$sql" | head -1)"
  rm -f "$sql"

  # The investor list is optional — the app works without it, discovering firms
  # per company instead. Loaded here because a pipeline that starts empty gives
  # a founder nothing to do on day one.
  if [ -f ../../data/investors.json ] && [ -n "$cid" ]; then
    bold "Loading the investor list"
    local dir; dir="$(mktemp -d)"
    node scripts/seed-investors.js "$cid" "$dir" 2>/dev/null
    local f count=0
    for f in "$dir"/*.sql; do
      $WRANGLER d1 execute "$DB_NAME" $scope --file="$f" >/dev/null 2>&1 \
        && count=$((count+1)) \
        || warn "chunk $(basename "$f") failed — re-apply it by hand"
    done
    rm -rf "$dir"
    ok "investor list loaded ($count chunks)"
    echo "     They arrive unscored. Sign in, analyze your deck, then click"
    echo "     \"Score against my deck\" on the Directory."
  fi
}

# ------------------------------------------------------------------- local mode
do_local() {
  check_prereqs
  write_dev_vars "$(resolve_api_key)"

  # --local keeps everything in .wrangler/state. The REPLACE_WITH placeholders in
  # wrangler.toml are fine here: the id is only consulted for remote calls, which
  # is why local mode needs no Cloudflare account at all.
  bold "Preparing local database"
  $WRANGLER d1 execute "$DB_NAME" --local --persist-to .wrangler/state --file=schema.sql >/dev/null 2>&1 \
    && ok "schema applied to local D1" \
    || die "Could not apply schema.sql to the local database."

  ensure_owner "--local --persist-to .wrangler/state"

  bold "Building"
  node build.js >/dev/null && ok "built .assets/"

  check_port
  bold "Starting"
  echo "  http://localhost:$PORT  —  sign in with the account printed above"
  echo
  # Both commands must share a persist directory or they address different local
  # databases: the schema and seed land in one, `pages dev` reads the other, and
  # every login fails against a database that is demonstrably populated.
  exec $WRANGLER pages dev .assets --port "$PORT" --persist-to .wrangler/state
}

# ------------------------------------------------------------------ deploy mode
require_cf_login() {
  $WRANGLER whoami >/dev/null 2>&1 || die "Not logged in to Cloudflare. Run: npx wrangler login"
  ok "cloudflare authenticated"
}

# Two accounts on one login makes every remote command ambiguous in
# non-interactive mode, which is the failure this pins down up front.
resolve_account_id() {
  if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then echo "$CLOUDFLARE_ACCOUNT_ID"; return; fi
  local ids
  ids="$($WRANGLER whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | sort -u)"
  [ "$(echo "$ids" | grep -c .)" -eq 1 ] || die "Multiple (or zero) Cloudflare accounts found.
     Re-run as: CLOUDFLARE_ACCOUNT_ID=<id> $0 deploy"
  echo "$ids"
}

# Create the D1 database only if a database of that name isn't already there,
# then return its id either way. This is what makes deploy re-runnable.
ensure_database() {
  local id
  id="$($WRANGLER d1 list --json 2>/dev/null \
        | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
            try{const m=(JSON.parse(s)||[]).find(d=>d.name==='$DB_NAME');process.stdout.write(m?(m.uuid||m.database_id||''):'')}catch(e){}
          })")"
  if [ -z "$id" ]; then
    $WRANGLER d1 create "$DB_NAME" >/dev/null 2>&1 || true
    id="$($WRANGLER d1 list --json 2>/dev/null \
          | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
              try{const m=(JSON.parse(s)||[]).find(d=>d.name==='$DB_NAME');process.stdout.write(m?(m.uuid||m.database_id||''):'')}catch(e){}
            })")"
  fi
  [ -n "$id" ] || die "Could not create or find the D1 database '$DB_NAME'."
  echo "$id"
}

# wrangler.toml ships with placeholders and the original author's account id.
# Rewriting both is what makes this repo installable by someone who is not them.
patch_config() {
  local db_id="$1" acct="$2"
  node -e '
    const fs=require("fs");
    const [dbId,acct]=process.argv.slice(1);
    let t=fs.readFileSync("wrangler.toml","utf8");
    t=t.replace(/^database_id = ".*"$/gm, `database_id = "${dbId}"`);
    t=t.replace(/^account_id = ".*"$/m,   `account_id = "${acct}"`);
    fs.writeFileSync("wrangler.toml",t);
  ' "$db_id" "$acct"
  ok "wrangler.toml points at this account and database"
}

do_deploy() {
  check_prereqs
  require_cf_login
  local acct db_id key
  acct="$(resolve_account_id)";   ok "account $acct"
  db_id="$(ensure_database)";     ok "database $DB_NAME ($db_id)"
  patch_config "$db_id" "$acct"

  bold "Applying schema"
  # CREATE TABLE IF NOT EXISTS throughout, so this is safe on an existing deploy.
  $WRANGLER d1 execute "$DB_NAME" --remote --file=schema.sql >/dev/null && ok "schema applied"

  bold "Setting secrets"
  key="$(resolve_api_key)"
  printf '%s' "$key" | $WRANGLER pages secret put ANTHROPIC_API_KEY --project-name fundraise-crm >/dev/null 2>&1 \
    && ok "ANTHROPIC_API_KEY set" || warn "could not set ANTHROPIC_API_KEY (set it in the dashboard)"
  node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))' \
    | $WRANGLER pages secret put SESSION_SECRET --project-name fundraise-crm >/dev/null 2>&1 \
    && ok "SESSION_SECRET set" || warn "could not set SESSION_SECRET (set it in the dashboard)"

  ensure_owner --remote

  bold "Deploying"
  node build.js >/dev/null
  $WRANGLER pages deploy .assets --project-name fundraise-crm
  echo
  bold "Done. Sign in at the URL above with the account printed earlier."
  echo "  This instance is invite-only. Add people with:"
  echo "    node scripts/seed-user.js <user> \"<Name>\" \"\" \"\" <your company_id>   # shares your pipeline"
  echo "    node scripts/seed-user.js <user> \"<Name>\" \"<Their Company>\"          # their own pipeline"
  echo "  then apply the SQL it prints with: npx wrangler d1 execute $DB_NAME --remote --file=..."
  echo "  To open self-serve signup instead, set SIGNUP_OPEN = \"true\" in wrangler.toml"
  echo "  and redeploy. Accounts made that way are always 'founder', never 'admin'."
}

# ------------------------------------------------------------------ doctor mode
do_doctor() {
  bold "Investor CRM — install check"
  command -v node >/dev/null && ok "node $(node -v)" || warn "node missing"

  if [ -f .dev.vars ]; then
    # The exact corruption seen in the wild: a value split across lines, so the
    # binding silently resolves to nothing and every model call fails at runtime.
    local bad
    bad="$(grep -vcE '^[A-Z_]+=|^$' .dev.vars || true)"
    [ "$bad" = "0" ] && ok ".dev.vars well-formed" || warn ".dev.vars has $bad malformed line(s) — re-run: ./setup.sh local"
    grep -q '^ANTHROPIC_API_KEY=.\+' .dev.vars && ok "ANTHROPIC_API_KEY present" || warn "ANTHROPIC_API_KEY missing"
    grep -q '^SESSION_SECRET=.\+'    .dev.vars && ok "SESSION_SECRET present"    || warn "SESSION_SECRET missing"
  else
    warn ".dev.vars missing — run: ./setup.sh local"
  fi

  grep -q 'REPLACE_WITH' wrangler.toml \
    && warn "wrangler.toml still has placeholder database ids (fine for local, blocks deploy)" \
    || ok "wrangler.toml configured"
  [ -f .assets/_worker.js ] || [ -d .assets/_worker.js ] && ok ".assets/ built" || warn "run: node build.js"

  if curl -fsS -o /dev/null "http://localhost:$PORT/login" 2>/dev/null; then
    ok "server responding on :$PORT"
  else
    warn "nothing responding on :$PORT"
  fi
}

MODE="${1:-}"
case "$MODE" in
  local)  do_local ;;
  deploy) do_deploy ;;
  doctor) do_doctor ;;
  *) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
