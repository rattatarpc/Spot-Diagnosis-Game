module.exports = [
    {
        files: ['app-services.js', 'tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                window: 'readonly',
                module: 'readonly',
                document: 'readonly',
                Blob: 'readonly',
                URL: 'readonly',
                crypto: 'readonly'
                ,require: 'readonly'
            }
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': 'warn',
            'semi': ['error', 'always']
        }
    }
];
