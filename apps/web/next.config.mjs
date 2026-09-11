/** @type {import('next').NextConfig} */
const nextConfig = {
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
