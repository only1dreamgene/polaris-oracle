import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'wasm/**', 'data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      // NestJS DI and this repo's DB/config layers lean on `any` at a few
      // deliberate seams (contract.Client casts, config.get<T>()) — off
      // rather than fighting those individually.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // main.ts and configuration.ts already carry deliberate
      // eslint-disable-next-line no-console comments at their few
      // legitimate bootstrap-time logs (before Nest's own Logger exists) —
      // this rule is what makes those disables meaningful instead of dead.
      // Everywhere else should use Nest's Logger, not console directly.
      'no-console': 'warn',
    },
  },
);
