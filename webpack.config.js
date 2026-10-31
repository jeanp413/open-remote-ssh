//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');

/**@type {import('webpack').Configuration}*/
const config = {
    target: 'node',
    entry: {
        extension: './src/extension.ts',
        'native/askpass-node': './src/native/askpass/askpass-node.ts',
        'native/nativeSshServer': './src/native/nativeSshServer.ts',
    },
    output: {
        path: path.resolve(__dirname, 'lib'),
        filename: '[name].js',
        copy: [
            { from: path.resolve(__dirname, 'src/scripts/server-setup.sh'), to: 'scripts', preservePermissions: true },
            { from: path.resolve(__dirname, 'src/scripts/server-setup.ps1'), to: 'scripts', preservePermissions: true },
            { from: path.resolve(__dirname, 'src/native/askpass/askpass.sh'), to: 'native', preservePermissions: true },
            { from: path.resolve(__dirname, 'src/native/askpass/askpass.ps1'), to: 'native', preservePermissions: true },
        ],
        libraryTarget: "commonjs2",
        devtoolModuleFilenameTemplate: "../[resource-path]",
    },
    devtool: 'source-map',
    externals: {
        vscode: "commonjs vscode",
        bufferutil: "bufferutil",
        "utf-8-validate": "utf-8-validate",
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [{
            test: /\.ts$/,
            exclude: /node_modules/,
            use: [{
                loader: 'ts-loader'
            }]
        }]
    },
    plugins: [
        new webpack.IgnorePlugin({
            resourceRegExp: /crypto\/build\/Release\/sshcrypto\.node$/,
        }),
        new webpack.IgnorePlugin({
            resourceRegExp: /cpu-features/,
        }),
    ]
}

module.exports = (_env, argv) => {
    if (argv.mode === 'production') {
        config.devtool = false;
    }

    return config;
};
