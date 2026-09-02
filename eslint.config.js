import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'package-lock.json'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
    },
  },
  {
    files: ['bridge/public/**/*.js', 'extension/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        chrome: 'readonly',
      },
    },
  },
];
