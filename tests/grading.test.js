const test = require('node:test');
const assert = require('node:assert/strict');
const { levenshteinDistance } = require('../app-services.js');

test('Levenshtein distance handles exact and typo matches', () => {
    assert.equal(levenshteinDistance('ecg', 'ecg'), 0);
    assert.equal(levenshteinDistance('tachycardia', 'tachycardi'), 1);
});

test('Levenshtein distance handles empty values', () => {
    assert.equal(levenshteinDistance('', 'abc'), 3);
    assert.equal(levenshteinDistance('abc', ''), 3);
});
