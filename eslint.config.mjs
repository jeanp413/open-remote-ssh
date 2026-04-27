// @ts-check

import { defineConfig, globalIgnores } from 'eslint/config';
// import typescriptEslintEslintPlugin from '@typescript-eslint/eslint-plugin';
import jsdoc from 'eslint-plugin-jsdoc';
import tsParser from '@typescript-eslint/parser';
import stylistic from '@stylistic/eslint-plugin';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default defineConfig(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    [
    globalIgnores([
        '**/node_modules/',
        '**/out/',
        '**/lib/',
        '**/*.d.ts',
        '**/*.js',
    ]),
    {
        plugins: {
            '@stylistic': stylistic,
            // '@typescript-eslint': typescriptEslintEslintPlugin,
            jsdoc,
        },
        // languageOptions: {
        //     parser: tsParser,
        //     ecmaVersion: 6,
        //     sourceType: 'module',
        // },
        rules: {
            'constructor-super': 'warn',
            curly: 'warn',
            eqeqeq: 'warn',
            'no-buffer-constructor': 'warn',
            'no-caller': 'warn',
            'no-case-declarations': 'warn',
            'no-debugger': 'warn',
            'no-duplicate-case': 'warn',
            'no-duplicate-imports': 'warn',
            'no-eval': 'warn',
            'no-async-promise-executor': 'warn',
            'no-extra-semi': 'warn',
            'no-new-wrappers': 'warn',
            'no-redeclare': 'off',
            'no-sparse-arrays': 'warn',
            'no-throw-literal': 'warn',
            'no-unsafe-finally': 'warn',
            'no-unused-labels': 'warn',
            'no-restricted-globals': [
                'warn',
                'name',
                'length',
                'event',
                'closed',
                'external',
                'status',
                'origin',
                'orientation',
                'context',
            ],
            'no-var': 'warn',
            'jsdoc/no-types': 'warn',
            semi: 'off',
            '@stylistic/semi': 'warn',
            '@stylistic/member-delimiter-style': 'warn',
            '@typescript-eslint/naming-convention': [
                'warn',
                {
                    selector: 'class',
                    format: ['PascalCase'],
                }
            ],
            quotes: 'off',
            '@stylistic/quotes': [
                'warn',
                'single',
                {
                    allowTemplateLiterals: true,
                }
            ],
        },
    },
]);
