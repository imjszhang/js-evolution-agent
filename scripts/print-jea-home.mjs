#!/usr/bin/env node
import { resolve } from 'node:path';
import { createRuntimeContext } from '../src/infra/jea-home.mjs';
import { getProjectRoot, loadProjectEnv } from '../src/infra/project.mjs';

const sourceRoot = process.argv[2] ? resolve(process.argv[2]) : getProjectRoot();
loadProjectEnv(sourceRoot);
process.stdout.write(createRuntimeContext({ sourceRoot }).jeaHome);
