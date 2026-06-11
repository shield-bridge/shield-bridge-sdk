const path = require('path');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');

const distPath = path.resolve(__dirname, 'dist');

// Plugins shared by both the browser and Node worker bundles.
const sharedPlugins = () => [
  new webpack.IgnorePlugin({
    resourceRegExp: /^\.\/wordlists\/(?!english)/,
  }),
  new webpack.IgnorePlugin({
    resourceRegExp: /bip39\/src$/,
  }),
  // Replace bundled sapling parameters (~65MB) with small stubs.
  // Parameters are loaded lazily from disk/CDN at runtime instead.
  new webpack.NormalModuleReplacementPlugin(
    /saplingOutputParams$/,
    path.resolve(__dirname, 'src/stubs/saplingOutputParams.cjs'),
  ),
  new webpack.NormalModuleReplacementPlugin(
    /saplingSpendParams$/,
    path.resolve(__dirname, 'src/stubs/saplingSpendParams.cjs'),
  ),
];

const minimizer = () => [
  new TerserPlugin({
    terserOptions: {
      format: {
        comments: false,
      },
    },
    extractComments: false,
  }),
];

// Browser Web Worker bundle (target: web). Loaded via
// `new URL('./saplingWorker.js', import.meta.url)` in the browser.
const webConfig = {
  name: 'web',
  mode: 'production',
  entry: './dist/worker.js',
  output: {
    filename: 'saplingWorker.js',
    path: distPath,
  },
  optimization: {
    minimize: true,
    minimizer: minimizer(),
  },
  plugins: [
    // Browser needs the Buffer / process polyfills.
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
    }),
    ...sharedPlugins(),
  ],
};

// Node worker_threads bundle (target: node). Emitted as `.cjs` so Node
// evaluates it as CommonJS even though package.json sets "type":"module" —
// otherwise the worker's `eval('require')` throws "require is not defined in
// ES module scope" and the worker crashes on load. Loaded by index.ts in Node
// via `new Worker(path.join(currentDir, 'saplingWorker.cjs'))`.
const nodeConfig = {
  name: 'node',
  mode: 'production',
  target: 'node',
  entry: './dist/worker.js',
  output: {
    filename: 'saplingWorker.cjs',
    path: distPath,
  },
  // Use the real Node __filename/__dirname so getDefaultParamsUrls() resolves
  // the sapling .params files next to the bundle in dist/.
  node: {
    __filename: false,
    __dirname: false,
  },
  optimization: {
    minimize: true,
    minimizer: minimizer(),
  },
  // No Buffer/process ProvidePlugin: Node has them as globals natively.
  plugins: sharedPlugins(),
};

module.exports = [webConfig, nodeConfig];
