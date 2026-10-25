const test = require('node:test');
const assert = require('node:assert/strict');
const {
    levenshteinDistance,
    gradeMultiChoice,
    sanitizeStudentId,
    hashPinSync,
    verifyPinSync,
    getAssignmentWindowState,
    canStudentSeeAnswerKey,
    computeAttemptTotalScore,
    buildOfflineAttemptsCsv,
    verifyAdminCredentials,
    findMatchingOfflineAttempt
} = require('../app-services.js');

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

test('sanitizeStudentId strips Firebase-illegal characters and whitespace', () => {
    assert.equal(sanitizeStudentId(' 6501.02#03$04[05]06/07 '), '6501_02_03_04_05_06_07');
    assert.equal(sanitizeStudentId('STD 123'), 'STD_123');
});

test('hashPinSync and verifyPinSync validate reviewer PIN', () => {
    const hash = hashPinSync('482910', 'ABC123');
    assert.equal(hash.length, 16);
    assert.equal(verifyPinSync('482910', hash, 'ABC123'), true);
    assert.equal(verifyPinSync('999999', hash, 'ABC123'), false);
    assert.equal(verifyPinSync('482910', hash, 'OTHER'), false);
});

test('getAssignmentWindowState evaluates open/close timestamps', () => {
    const meta = { opensAt: 1000, closesAt: 2000 };
    assert.equal(getAssignmentWindowState(meta, 500).state, 'not_open_yet');
    assert.equal(getAssignmentWindowState(meta, 1000).state, 'open');
    assert.equal(getAssignmentWindowState(meta, 1500).state, 'open');
    assert.equal(getAssignmentWindowState(meta, 2000).state, 'closed');
    assert.equal(getAssignmentWindowState({}, 500).state, 'open');
});

test('canStudentSeeAnswerKey requires BOTH released AND closed', () => {
    const metaOpen = { closesAt: 2000, resultsReleasedAll: false };
    // Not released, not closed
    assert.equal(canStudentSeeAnswerKey(metaOpen, { released: false }, 1500), false);
    // Individual released, but quiz still open -> NO answer key leak!
    assert.equal(canStudentSeeAnswerKey(metaOpen, { released: true }, 1500), false);
    // Whole room released, but quiz still open -> NO answer key leak!
    assert.equal(canStudentSeeAnswerKey({ closesAt: 2000, resultsReleasedAll: true }, {}, 1500), false);
    // Quiz closed, but not released -> NO
    assert.equal(canStudentSeeAnswerKey(metaOpen, { released: false }, 2500), false);
    // Quiz closed AND released (individual or room) -> YES
    assert.equal(canStudentSeeAnswerKey(metaOpen, { released: true }, 2500), true);
    assert.equal(canStudentSeeAnswerKey({ closesAt: 2000, resultsReleasedAll: true }, {}, 2500), true);
});

test('computeAttemptTotalScore prefers teacherPoints over autoPoints and skips slides/freePoint', () => {
    const quiz = [
        { type: 'multiple-choice' },
        { type: 'typing' },
        { type: 'slide' },
        { type: 'multiple-choice', freePoint: true }
    ];
    const grading = {
        0: { autoPoints: 100 },
        1: { autoPoints: 30, teacherPoints: 45 },
        2: { autoPoints: 999 },
        3: { autoPoints: 100 }
    };
    assert.equal(computeAttemptTotalScore(grading, quiz), 145);
});

test('buildOfflineAttemptsCsv formats Thai text and scores properly', () => {
    const quiz = [
        { type: 'multiple-choice', text: 'Q1' },
        { type: 'slide', text: 'Slide' },
        { type: 'typing', text: 'Q2' }
    ];
    const attempts = {
        '65001': {
            name: 'สมชาย ใจดี',
            status: 'submitted',
            elapsedSec: 125,
            submittedAt: 1700000000000,
            overallFeedback: 'ทำได้ดีมาก "เยี่ยม"',
            answers: {
                0: { value: 'Atrial fibrillation' },
                2: { value: 'ST elevation' }
            },
            grading: {
                0: { autoPoints: 100, comment: 'ถูกต้อง' },
                2: { autoPoints: 20, teacherPoints: 35, comment: 'เพิ่มคะแนนให้', needsReview: true }
            }
        }
    };
    const csv = buildOfflineAttemptsCsv(quiz, attempts, { resultsReleasedAll: true });
    assert.ok(csv.includes('"สมชาย ใจดี"'));
    assert.ok(csv.includes('"released"'));
    assert.ok(csv.includes('"135"')); // 100 + 35
    assert.ok(csv.includes('"ทำได้ดีมาก ""เยี่ยม"""'));
});

test('verifyAdminCredentials accepts Admin / 00 and rejects wrong inputs', () => {
    assert.equal(verifyAdminCredentials('Admin', '00'), true);
    assert.equal(verifyAdminCredentials('admin', '00'), true);
    assert.equal(verifyAdminCredentials('  ADMIN  ', '00'), true);
    assert.equal(verifyAdminCredentials('Admin', '0'), false);
    assert.equal(verifyAdminCredentials('Admin', '000'), false);
    assert.equal(verifyAdminCredentials('other', '00'), false);
});

test('findMatchingOfflineAttempt matches by exact ID, case-insensitive ID, swapped fields, and Name fallback', () => {
    const attempts = {
        '600': { studentId: '600', name: 'PS', status: 'released', released: true, totalScore: 300 },
        '900': { studentId: '900', name: 'PD', status: 'in_progress', totalScore: 0 }
    };

    // Exact Student ID
    assert.equal(findMatchingOfflineAttempt(attempts, '600', 'PS', true)?.studentId, '600');
    // Leading zero / numeric ID equivalence
    assert.equal(findMatchingOfflineAttempt(attempts, '0600', '', true)?.studentId, '600');
    // Swapped fields (Name put in Student ID box, ID put in Name box)
    assert.equal(findMatchingOfflineAttempt(attempts, 'PS', '600', true)?.studentId, '600');
    // Name only in Name box (e.g. Student ID left blank or has quiz code)
    assert.equal(findMatchingOfflineAttempt(attempts, 'NELZHQ', 'ps', true)?.studentId, '600');
    // Name only in Student ID box
    assert.equal(findMatchingOfflineAttempt(attempts, '  ps ', '', true)?.studentId, '600');
    // In assignment mode (allowNameFallback = false), new Student ID does not collide with another student of same name
    assert.equal(findMatchingOfflineAttempt(attempts, '700', 'PS', false), null);
});
