import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const EXPECTED_VERSIONS = {
  'camoufox-js': '0.8.3',
  'playwright-core': '1.57.0'
};

export function assertCompatibleDependencyVersions() {
  const mismatches = [];

  for (const [pkg, expected] of Object.entries(EXPECTED_VERSIONS)) {
    let actual = null;
    try {
      actual = require(`${pkg}/package.json`).version;
    } catch (error) {
      throw new Error(`${pkg} is not installed. Run "pnpm install" in WebAdapterTools.`);
    }

    if (actual !== expected) {
      mismatches.push(`${pkg}@${actual} (expected ${expected})`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Incompatible browser automation dependencies: ${mismatches.join(', ')}. ` +
      'Run "pnpm install" in WebAdapterTools to install the pinned versions.'
    );
  }
}
