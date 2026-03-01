const path = require('path');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
  mode: 'production',
  entry: './dist/worker.js',
  output: {
    filename: 'saplingWorker.js',
    path: path.resolve(__dirname, 'dist'),
  },
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          format: {
            comments: false,
          },
        },
        extractComments: false,
      }),
    ],
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
    }),
    new webpack.IgnorePlugin({
      resourceRegExp: /^\.\/wordlists\/(?!english)/,
    }),
    new webpack.IgnorePlugin({
      resourceRegExp: /bip39\/src$/,
    }),
    // Replace bundled sapling parameters (~65MB) with small stubs
    // Parameters are loaded lazily from CDN at runtime instead
    new webpack.NormalModuleReplacementPlugin(
      /saplingOutputParams$/,
      path.resolve(__dirname, 'src/stubs/saplingOutputParams.cjs'),
    ),
    new webpack.NormalModuleReplacementPlugin(
      /saplingSpendParams$/,
      path.resolve(__dirname, 'src/stubs/saplingSpendParams.cjs'),
    ),
  ],
};
