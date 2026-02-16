const js = require('@eslint/js');
const vue = require('eslint-plugin-vue');
const prettier = require('eslint-config-prettier');
const prettierPlugin = require('eslint-plugin-prettier');
const globals = require('globals');
const parser = require('vue-eslint-parser');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  // Configuración base de ESLint
  js.configs.recommended,

  // Reglas nuevas de ESLint 10: desactivadas temporalmente (ver migración)
  // preserve-caught-error: requiere cause al re-lanzar errores
  // no-useless-assignment: falsos positivos con reactividad Vue
  {
    rules: {
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },

  // Desactiva reglas de formato que entran en conflicto con Prettier
  prettier,

  // Configuración para archivos JavaScript
  {
    files: ['**/*.js'],
    plugins: {
      prettier: prettierPlugin,
    },
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      'prettier/prettier': 'warn',
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      // Permitir variables no usadas que empiecen con _ o estén en catch blocks
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_|^(e|error|.*Error)$',
        },
      ],
      // Permitir declaraciones en case blocks si están en bloques
      'no-case-declarations': 'off',
      // Advertir sobre escape innecesario
      'no-useless-escape': 'warn',
    },
  },

  // Configuración para archivos Vue usando configs flat
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    plugins: {
      prettier: prettierPlugin,
    },
    languageOptions: {
      parser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 2025,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
      globals: {
        ...globals.browser,
        console: 'readonly',
      },
    },
    rules: {
      'prettier/prettier': 'warn',
      // Reglas personalizadas
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'warn',
      'vue/component-api-style': ['error', ['script-setup', 'composition']],
      // Desactivar regla de self-closing (conflicto con Prettier)
      // Prettier maneja el formato de self-closing automáticamente
      'vue/html-self-closing': 'off',
      // Desactivar regla de saltos de línea en elementos con contenido (conflicto con Prettier)
      // Prettier decide cuándo compactar o expandir elementos
      'vue/singleline-html-element-content-newline': 'off',
      // Desactivar regla de indentación HTML (conflicto con Prettier)
      // Prettier maneja la indentación automáticamente
      'vue/html-indent': 'off',
      // Desactivar regla de closing bracket (conflicto con Prettier, causa circular fixes)
      'vue/html-closing-bracket-newline': 'off',
      // Permitir variables no usadas que empiecen con _ o estén en catch blocks
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_|^(e|error|.*Error)$',
        },
      ],
      // Permitir declaraciones en case blocks si están en bloques
      'no-case-declarations': 'off',
    },
  },

  // Archivos TypeScript (.ts): parser para sintaxis TS
  {
    files: ['**/*.ts'],
    plugins: {
      prettier: prettierPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2025,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.browser,
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        NodeJS: 'readonly',
        Electron: 'readonly',
      },
    },
    rules: {
      'prettier/prettier': 'warn',
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_|^(e|error|.*Error)$',
        },
      ],
    },
  },

  // Tests (Jest): describe, it, expect (solo globals; parser TS aplicado por bloque anterior)
  {
    files: ['__tests__/**/*.js', '__tests__/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },

  // Scripts Node (scripts/*.ts): console, process, etc.
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Archivos CommonJS (.cjs): module, exports, require, process
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  // Ignorar directorios y archivos de configuración
  {
    ignores: [
      'dist-electron/**',
      'dist/**',
      'node_modules/**',
      '*.db',
      '*.log',
      'package-lock.json',
      'eslint.config.cjs',
      'vite.config.ts',
    ],
  },
];
