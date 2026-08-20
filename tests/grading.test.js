const test = require('node:test');
const assert = require('node:assert/strict');
const { levenshteinDistance, gradeMultiChoice } = require('../app-services.js');

test('Levenshtein distance handles exact and typo matches', () => {
    assert.equal(levenshteinDistance('ecg', 'ecg'), 0);
    assert.equal(levenshteinDistance('tachycardia', 'tachycardi'), 1);
});

test('Levenshtein distance handles empty values', () => {
    assert.equal(levenshteinDistance('', 'abc'), 3);
    assert.equal(levenshteinDistance('abc', ''), 3);
});

test('gradeMultiChoice: single correct answer legacy', () => {
    const q = { correctAnswers: [{ text: 'A' }], correctAnswer: { text: 'A' } };
    assert.deepEqual(gradeMultiChoice('A', q), { points: 70, correct: true });
    assert.deepEqual(gradeMultiChoice('B', q), { points: 0, correct: false });
});

test('gradeMultiChoice: multiple correct answers scored 20 each', () => {
    const q = { correctAnswers: [{ text: 'A' }, { text: 'B' }] };
    // Selecting only one correct answer (not all) => 20 pts, no bonus
    assert.deepEqual(gradeMultiChoice(['A'], q), { points: 20, correct: true });
    // Selecting all correct answers => 40 + 50 bonus
    assert.deepEqual(gradeMultiChoice(['A', 'B'], q), { points: 90, correct: true });
});

test('gradeMultiChoice: any wrong selection gives 0', () => {
    const q = { correctAnswers: [{ text: 'A' }, { text: 'B' }] };
    assert.deepEqual(gradeMultiChoice(['A', 'C'], q), { points: 0, correct: false });
    assert.deepEqual(gradeMultiChoice(['C'], q), { points: 0, correct: false });
});

test('gradeMultiChoice: empty selection gives 0', () => {
    const q = { correctAnswers: [{ text: 'A' }] };
    assert.deepEqual(gradeMultiChoice([], q), { points: 0, correct: false });
    assert.deepEqual(gradeMultiChoice(null, q), { points: 0, correct: false });
});
