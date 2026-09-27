const inferenceKeyNames = ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'TOGETHER_API_KEY'];

function assertProductionConfig(env) {
  if (env.NODE_ENV !== 'production') return;

  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'].filter((name) => !env[name]?.trim());
  if (!inferenceKeyNames.some((name) => env[name]?.trim())) {
    missing.push('GROQ_API_KEY/CEREBRAS_API_KEY/TOGETHER_API_KEY');
  }
  if (missing.length) {
    throw new Error(`Production configuration missing: ${missing.join(', ')}`);
  }

  let supabaseUrl;
  try {
    supabaseUrl = new URL(env.SUPABASE_URL);
  } catch {
    throw new Error('Production SUPABASE_URL must be an HTTPS URL.');
  }
  if (supabaseUrl.protocol !== 'https:' || supabaseUrl.username || supabaseUrl.password) {
    throw new Error('Production SUPABASE_URL must be an HTTPS URL without user info.');
  }
  if (env.ENABLE_TEST_ENDPOINTS === 'true') {
    throw new Error('ENABLE_TEST_ENDPOINTS is forbidden in production.');
  }
}

module.exports = { assertProductionConfig };
