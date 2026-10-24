// The gate's linter — deliberately TWO rules. no-dupe-keys: a duplicate key in
// an object literal silently discards the earlier value (the speculation
// context carried patientTextAll twice; the later, older one won for weeks).
// no-unused-vars: a dead name is usually a typo twin (this.hindiInCall next to
// eleven this._hindiInCall). Everything else is style, and style is not a gate.
module.exports = [
  { ignores: ['node_modules/**', 'tests/**', 'tools/**', '_tmp_*.js', 'scripts/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly', Buffer: 'readonly', __dirname: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly', URL: 'readonly', AbortController: 'readonly', fetch: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly' } },
    rules: { 'no-dupe-keys': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }] },
  },
];
