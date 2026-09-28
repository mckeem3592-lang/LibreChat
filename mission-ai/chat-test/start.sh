#!/usr/bin/env bash
# Deployment wiring for the separate Mission AI test chat. Never source this file.
set +x
set -euo pipefail
umask 077

fail() { printf '%s\n' "Mission AI test chat: $1" >&2; exit 1; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_dir"

[[ $# -le 1 && ( $# -eq 0 || ${1-} == --check ) ]] || fail 'expected no arguments or --check'
command -v node >/dev/null || fail 'Node.js is required'

# dotenv runs later in LibreChat. Do not let an unreviewed file add credentials
# after these checks; Render environment values are this deployment's source.
[[ ! -s .env ]] || fail 'remove the nonempty repository .env before starting'
for variable in $(compgen -e); do
  [[ -n ${!variable} ]] || continue
  case "$variable" in
    MONGO_URI|JWT_SECRET|JWT_REFRESH_SECRET|CREDS_KEY|CREDS_IV|MISSION_AI_NATIVE_TOKEN|MISSION_AI_GATEWAY_URL|\
    MISSION_AI_MANAGED_CHAT|MISSION_AI_BOOTSTRAP_OWNER|MISSION_AI_OWNER_EMAIL|MISSION_AI_OWNER_PASSWORD|MISSION_AI_CONTROL_OWNER_EMAIL)
      continue ;;
    OPENAI_*|ANTHROPIC_*|AZURE_*|ASSISTANTS_*|GOOGLE_*|GEMINI_*|BEDROCK_*|AWS_*|VERTEX_*|\
    ANYSCALE_*|APIPIE_*|COHERE_*|DEEPSEEK_*|DATABRICKS_*|FIREWORKS_*|GROQ_*|HUGGINGFACE_*|\
    MISTRAL_*|OPENROUTER_*|PERPLEXITY_*|SHUTTLEAI_*|TOGETHERAI_*|UNIFY_*|XAI_*|\
    IMAGE_GEN_*|DALLE*|FLUX_*|SD_WEBUI_*|STT_*|TTS_*|TAVILY_*|TRAVERSAAL_*|ZAPIER_*|\
    SERPER_*|SERPAPI_*|FIRECRAWL_*|JINA_*|RAG_*|OCR_*|LIBRECHAT_CODE_*|CODEAPI_*|\
    MISSION_AI_*|MCP_*|LANGFUSE_*|LANGSMITH_*|OPENID_*|SAML_*|LDAP_*|\
    *_KEY|*_KEY_ID|*_KEY_FILE|*_TOKEN|*_SECRET|*_PASSWORD|*_CREDENTIALS|\
    PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|\
    DOTENV_*|REDIS_URI|REDIS_URL|MEILI_HOST|MEILI_MASTER_KEY|\
    DEPLOYMENT_PLUGINS_DIR|DEPLOYMENT_PLUGIN_DATA_DIR|DEPLOYMENT_SKILLS_DIR)
      fail "unsupported credential or upstream setting: $variable" ;;
  esac
done

[[ ${MISSION_AI_GATEWAY_URL-} == https://mission-ai-gateway-mckee.onrender.com ]] ||
  fail 'MISSION_AI_GATEWAY_URL must match the reviewed gateway origin'
[[ ${MISSION_AI_MANAGED_CHAT-} == true ]] || fail 'MISSION_AI_MANAGED_CHAT must explicitly enable the managed API guard'
native_token="${MISSION_AI_NATIVE_TOKEN-}"
[[ ${#native_token} -ge 32 && $native_token != *[[:space:]]* ]] || fail 'MISSION_AI_NATIVE_TOKEN must contain at least 32 characters without whitespace'
[[ ${JWT_SECRET-} =~ ^[[:xdigit:]]{64}$ ]] || fail 'JWT_SECRET must be a private, persistent 32-byte hex value'
[[ ${JWT_REFRESH_SECRET-} =~ ^[[:xdigit:]]{64}$ ]] || fail 'JWT_REFRESH_SECRET must be a private, persistent 32-byte hex value'
[[ ${CREDS_KEY-} =~ ^[[:xdigit:]]{64}$ ]] || fail 'CREDS_KEY must be a private, persistent 32-byte hex value'
[[ ${CREDS_IV-} =~ ^[[:xdigit:]]{32}$ ]] || fail 'CREDS_IV must be a private, persistent 16-byte hex value'
[[ $JWT_SECRET != "$JWT_REFRESH_SECRET" && $JWT_SECRET != "$CREDS_KEY" && $JWT_REFRESH_SECRET != "$CREDS_KEY" ]] ||
  fail 'application signing and encryption keys must be different'
for variable in JWT_SECRET JWT_REFRESH_SECRET CREDS_KEY CREDS_IV; do
  [[ $MISSION_AI_NATIVE_TOKEN != "${!variable}" ]] || fail 'native and application credentials must be different'
done

# Parse without printing the URI, password, or driver errors. No connection is made.
node <<'NODE'
try {
  const uri = new URL(process.env.MONGO_URI ?? '');
  const allowedOptions = new Set(['retryWrites', 'w', 'appName', 'authSource', 'tls']);
  const seen = new Set();
  if (uri.protocol !== 'mongodb+srv:' || !uri.hostname.endsWith('.mongodb.net') ||
      uri.port || uri.hash || uri.pathname !== '/MissionAIChatTest' ||
      decodeURIComponent(uri.username) !== 'mission_ai_chat_test' || !decodeURIComponent(uri.password)) throw 0;
  for (const [key, value] of uri.searchParams) {
    if (!allowedOptions.has(key) || seen.has(key)) throw 0;
    seen.add(key);
    if ((key === 'retryWrites' || key === 'tls') && value !== 'true') throw 0;
    if (key === 'w' && value !== 'majority') throw 0;
    if (key === 'authSource' && value !== 'admin') throw 0;
  }
  for (const name of ['DOMAIN_CLIENT', 'DOMAIN_SERVER']) {
    const origin = new URL(process.env[name] ?? '');
    if (origin.protocol !== 'https:' || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash || origin.port) throw 0;
  }
  if (process.env.DOMAIN_CLIENT !== process.env.DOMAIN_SERVER) throw 0;
} catch {
  console.error('Mission AI test chat: invalid dedicated Atlas connection or HTTPS application origins');
  process.exit(1);
}
NODE

managed_config="$repo_dir/mission-ai/config/librechat.shared-budget.yaml"
[[ -f $managed_config ]] || fail 'reviewed managed configuration is missing'
[[ ${CONFIG_PATH-$managed_config} == "$managed_config" ]] || fail 'CONFIG_PATH cannot select another configuration'
[[ ${ENDPOINTS-custom} == custom ]] || fail 'ENDPOINTS must be custom'
for variable in ALLOW_REGISTRATION ALLOW_SOCIAL_LOGIN ALLOW_SOCIAL_REGISTRATION \
  ALLOW_UNVERIFIED_EMAIL_LOGIN ALLOW_PASSWORD_RESET ALLOW_EMAIL_LOGIN_OVERRIDE SEARCH USE_REDIS \
  DEBUG_LOGGING DEBUG_CONSOLE AGENT_DEBUG_LOGGING TITLE_CONVO DEPLOYMENT_PLUGIN_HOOKS; do
  [[ ${!variable-false} == false ]] || fail "$variable must remain false"
  export "$variable=false"
done
[[ ${ALLOW_EMAIL_LOGIN-true} == true ]] || fail 'verified local email login must remain enabled'
[[ ${SESSION_COOKIE_SECURE-true} == true ]] || fail 'secure session cookies are required'
[[ ${NODE_TLS_REJECT_UNAUTHORIZED-1} != 0 ]] || fail 'TLS verification must remain enabled'
export CONFIG_PATH="$managed_config" ENDPOINTS=custom NODE_ENV=production HOST=0.0.0.0
export ALLOW_EMAIL_LOGIN=true SESSION_COOKIE_SECURE=true TRUST_PROXY=1
export PORT="${PORT:-10000}" SCARF_ANALYTICS=false

case "${MISSION_AI_BOOTSTRAP_OWNER-false}" in
  true)
    [[ -n ${MISSION_AI_OWNER_EMAIL-} && -n ${MISSION_AI_OWNER_PASSWORD-} ]] ||
      fail 'explicit owner bootstrap requires privately configured owner credentials' ;;
  false)
    [[ -z ${MISSION_AI_OWNER_EMAIL-} && -z ${MISSION_AI_OWNER_PASSWORD-} ]] ||
      fail 'owner credentials require explicit one-time bootstrap enablement' ;;
  *) fail 'MISSION_AI_BOOTSTRAP_OWNER must be true or false' ;;
esac

if [[ ${1-} == --check ]]; then
  printf '%s\n' 'Mission AI test chat: startup settings accepted; no database or provider request made'
  exit 0
fi
[[ -f client/dist/index.html ]] || fail 'frontend build is missing; run the reviewed build command first'
# Empty, private directories prevent repository defaults or copied deployment
# extensions from loading. Empty environment values alone select the defaults.
extension_dir="$(mktemp -d "${TMPDIR:-/tmp}/mission-ai-chat-extensions.XXXXXXXX")" ||
  fail 'could not prepare empty deployment extension directories'
mkdir "$extension_dir/plugins" "$extension_dir/skills" "$extension_dir/data"
export DEPLOYMENT_PLUGINS_DIR="$extension_dir/plugins"
export DEPLOYMENT_SKILLS_DIR="$extension_dir/skills"
export DEPLOYMENT_PLUGIN_DATA_DIR="$extension_dir/data"
if [[ ${MISSION_AI_BOOTSTRAP_OWNER-false} == true ]]; then
  node mission-ai/chat-test/bootstrap.cjs
fi
export MISSION_AI_CONTROL_OWNER_EMAIL="${MISSION_AI_CONTROL_OWNER_EMAIL:-${MISSION_AI_OWNER_EMAIL-}}"
unset MISSION_AI_BOOTSTRAP_OWNER MISSION_AI_OWNER_EMAIL MISSION_AI_OWNER_PASSWORD
exec node api/server/index.js
