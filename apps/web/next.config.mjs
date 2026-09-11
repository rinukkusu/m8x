import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server with only the traced runtime dependencies.
  // Without this the Docker image carries the full install, including the
  // platform SWC binaries and every build tool.
  output: 'standalone',
  // Tracing has to start at the monorepo root, or files from packages/core and
  // the hoisted node_modules are missed.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // @m8x/core is published as TypeScript source rather than a build artefact,
  // so the app compiles it alongside its own code. One less build step, and
  // editing a node definition hot-reloads the editor.
  transpilePackages: ['@m8x/core'],
  experimental: {
    serverActions: { bodySizeLimit: '4mb' },
  },
  eslint: { ignoreDuringBuilds: true },

  webpack(config) {
    // @m8x/core is NodeNext ESM, so its internal imports carry a `.js`
    // extension that points at a `.ts` file on disk. Node and tsx resolve that
    // themselves; webpack has to be told.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
