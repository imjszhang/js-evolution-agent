import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';

function hasValue(value) {
  return value != null && String(value).trim() !== '';
}

export function envFileForExecutionRoot(executionRoot) {
  if (!executionRoot) return null;
  return join(String(executionRoot), '.env');
}

export function readExecutionEnvFile(executionRoot) {
  const envPath = envFileForExecutionRoot(executionRoot);
  if (!envPath || !existsSync(envPath)) {
    return { envPath, exists: false, values: {} };
  }
  try {
    return {
      envPath,
      exists: true,
      values: parseDotenv(readFileSync(envPath, 'utf-8')),
    };
  } catch (error) {
    return {
      envPath,
      exists: true,
      values: {},
      error: error?.message ?? String(error),
    };
  }
}

export function buildExecutionEnv(executionRoot, { baseEnv = process.env, overrides = {} } = {}) {
  const loaded = readExecutionEnvFile(executionRoot);
  const env = { ...baseEnv };
  for (const [key, value] of Object.entries(loaded.values)) {
    if (hasValue(value)) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value == null) delete env[key];
    else env[key] = String(value);
  }
  return { env, envPath: loaded.envPath, envFileExists: loaded.exists, envFileError: loaded.error ?? null };
}

function applyProcessEnv(env) {
  const previous = new Map();
  const added = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === value) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) previous.set(key, process.env[key]);
    else added.add(key);
    process.env[key] = value;
  }
  return () => {
    for (const key of added) delete process.env[key];
    for (const [key, value] of previous.entries()) process.env[key] = value;
  };
}

export async function withExecutionEnv(executionRoot, fn, opts = {}) {
  const restore = applyProcessEnv(buildExecutionEnv(executionRoot, opts).env);
  try {
    return await fn();
  } finally {
    restore();
  }
}

export async function* streamWithExecutionEnv(executionRoot, iterableFactory, opts = {}) {
  const restore = applyProcessEnv(buildExecutionEnv(executionRoot, opts).env);
  try {
    for await (const item of iterableFactory()) yield item;
  } finally {
    restore();
  }
}
