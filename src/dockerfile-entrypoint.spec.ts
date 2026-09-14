import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '..');

/**
 * Regression for a real bug found deploying this image to Fly for the
 * first time: `nest build`'s output is flat (`dist/main.js`) because
 * `nest-cli.json`'s `sourceRoot: "src"` makes tsc treat `src` itself as
 * the effective rootDir — but the Dockerfile's CMD pointed at
 * `dist/src/main`, a path that never existed. Nothing had ever actually
 * run this Docker image before (only `npm start`/`npm run build` locally,
 * which never exercise the container's CMD), so the mismatch shipped
 * silently until a real deploy crash-looped on it.
 *
 * This file itself MUST live under `src/`, not the repo root — a
 * top-level `.spec.ts` file widens tsc's inferred rootDir back to the
 * repo root (since it's no longer just `src/**`), which flips the build
 * output to `dist/src/main.js` and breaks this exact check in the other
 * direction. Caught live while first writing this test at the repo root.
 */
describe('Dockerfile CMD matches the real build output', () => {
  it('points at a file that npm run build actually produces', () => {
    execSync('npm run build', { cwd: repoRoot, stdio: 'pipe' });

    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
    const match = dockerfile.match(/^CMD \["node", "([^"]+)"\]/m);
    if (!match) throw new Error('Dockerfile has no `CMD ["node", "..."]` entrypoint to check');

    const entrypoint = join(repoRoot, `${match[1]}.js`);
    expect(existsSync(entrypoint)).toBe(true);
  }, 30000);
});
