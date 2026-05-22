const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
  entry: './src/extension.ts',
  target: 'node',
  mode: 'production',
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  optimization: {
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          mangle: true,
          compress: {
            drop_console: true,
            drop_debugger: true,
            unused: true,
            dead_code: true,
            evaluate: true,
            booleans_as_integers: false,
            computed_props: true,
            hoist_funs: true,
            hoist_vars: false,
            if_return: true,
            inline: false,
            join_vars: true,
            loops: true,
            properties: true,
            reduce_funcs: true,
            reduce_vars: true,
            sequences: true,
            side_effects: true,
            switches: true,
            toplevel: false,
            typeofs: true,
            conditionals: true,
            comparisons: true,
            evaluate: true,
            arithmetics: true,
            strings: true,
            loops: true,
            cascade: true,
            side_effects: true,
          },
          format: {
            comments: false,
          },
        },
        extractComments: false,
      }),
    ],
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  stats: {
    warnings: false,
  },
};