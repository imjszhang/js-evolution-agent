/**
 * Frozen JEA 0.1.0 product identity (#120) plus package-time provenance (#142).
 * Change version/bundle fields only with a release decision; artifact names
 * and launcher discovery depend on them.
 */
export const PRODUCT_NAME = 'JEA';
export const PRODUCT_ID = 'jea';
export const BUNDLE_ID = 'com.imjszhang.jea';
export const PRODUCT_VERSION = '0.1.0';
export const RELEASE_PLATFORM = 'macos-arm64';
export const MINIMUM_MACOS_VERSION = '13.0';
export const EXECUTABLE_NAME = 'JEA';
export const APP_FILE_NAME = 'JEA.app';
export const CLI_BIN_NAME = 'jea';
export const DEFAULT_CLI_BIN_DIR = '~/.local/bin';
export const LAUNCHER_MARKER = 'jea-managed-launcher';
export const LAUNCHER_MARKER_VERSION = 1;
export const SIGNING_POLICY = 'ad-hoc';
export const START_SERVICES = ['localhost-web-host'];
export { BUILD_METADATA_FILENAME } from './build-metadata.mjs';

export function artifactNames(version = PRODUCT_VERSION) {
  return {
    dmg: `${PRODUCT_NAME}-${version}-${RELEASE_PLATFORM}.dmg`,
    zip: `${PRODUCT_NAME}-${version}-${RELEASE_PLATFORM}.zip`,
    checksums: 'SHA256SUMS',
    packageSmoke: 'package-smoke.json',
    releaseNotes: 'RELEASE_NOTES.md',
    buildMetadata: 'build-metadata.json',
  };
}

export {
  abbreviateCommit,
  assertCleanProvenance,
  collectBuildMetadata,
  loadBuildMetadata,
  writeBuildMetadata,
} from './build-metadata.mjs';

export function defaultAppCandidates(homeDir) {
  return [
    `/Applications/${APP_FILE_NAME}`,
    `${homeDir}/Applications/${APP_FILE_NAME}`,
  ];
}
