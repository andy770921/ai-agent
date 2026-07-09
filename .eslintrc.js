module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: ['eslint:recommended', 'prettier'],
  plugins: ['prettier'],
  rules: {
    'prettier/prettier': ['error'],
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  ignorePatterns: ['node_modules/', 'dist/', 'build/', 'coverage/', '.next/', 'next-env.d.ts'],
  overrides: [
    // TypeScript files
    {
      files: ['**/*.ts', '**/*.tsx'],
      parser: '@typescript-eslint/parser',
      plugins: ['@typescript-eslint'],
      extends: ['plugin:@typescript-eslint/recommended', 'prettier'],
      rules: {
        '@typescript-eslint/interface-name-prefix': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        // Honor the `_`-prefix convention already used for intentionally-unused
        // params (e.g. the Cloudflare Worker `scheduled(_event, env, _ctx)` signature).
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
      },
    },
    // Next.js frontend
    {
      files: ['frontend/**/*.ts', 'frontend/**/*.tsx', 'frontend/**/*.js', 'frontend/**/*.jsx'],
      extends: ['next/core-web-vitals', 'prettier'],
    },
    // Backend NestJS
    {
      files: ['backend/**/*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        project: './backend/tsconfig.json',
        sourceType: 'module',
      },
      env: {
        node: true,
        jest: true,
      },
    },
  ],
};
