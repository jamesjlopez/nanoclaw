import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('gemini-openai-claude', ({ hostEnv }) => {
  const dotenv = readEnvFile([
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GEMINI_MODEL',
    'GOOGLE_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'ANTHROPIC_MODEL',
    'CLAUDE_MODEL',
    'ANTHROPIC_BASE_URL',
  ]);

  const env: Record<string, string> = {};
  for (const key of [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GEMINI_MODEL',
    'GOOGLE_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'ANTHROPIC_MODEL',
    'CLAUDE_MODEL',
  ]) {
    const value = hostEnv[key] || dotenv[key];
    if (value) env[key] = value;
  }

  const anthropicBaseUrl = hostEnv.ANTHROPIC_BASE_URL || dotenv.ANTHROPIC_BASE_URL;
  if (anthropicBaseUrl) {
    env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }

  return Object.keys(env).length > 0 ? { env } : {};
});
