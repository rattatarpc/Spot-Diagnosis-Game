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
    findMatchingOfflineAttempt,
    summarizeGradingReason,
    buildConceptBreakdownItems
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
    assert.deepEqual(gradeMultiChoice('A', q), { points: 100, correct: true });
    assert.deepEqual(gradeMultiChoice('B', q), { points: 0, correct: false });
});

test('gradeMultiChoice: multiple correct answers scored with partial credit out of 100', () => {
    const q = { correctAnswers: [{ text: 'A' }, { text: 'B' }] };
    // Selecting only one correct answer (out of 2) => 50 pts
    assert.deepEqual(gradeMultiChoice(['A'], q), { points: 50, correct: true });
    // Selecting all correct answers => 100 pts
    assert.deepEqual(gradeMultiChoice(['A', 'B'], q), { points: 100, correct: true });
});

test('gradeMultiChoice: partial credit with wrong options deducting proportionally', () => {
    const q = {
        correctAnswers: [{ text: 'A' }, { text: 'B' }],
        options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }]
    };
    // 1 correct (1/2) and 1 wrong (1/2) => net 0 pts
    assert.deepEqual(gradeMultiChoice(['A', 'C'], q), { points: 0, correct: false });
    // 2 correct (2/2) and 1 wrong (1/2) => net 0.5 (50 pts)
    assert.deepEqual(gradeMultiChoice(['A', 'B', 'C'], q), { points: 50, correct: true });
    // selecting only wrong choice => 0 pts
    assert.deepEqual(gradeMultiChoice(['C'], q), { points: 0, correct: false });
    // selecting all choices (guessing all) => 0 pts
    assert.deepEqual(gradeMultiChoice(['A', 'B', 'C', 'D'], q), { points: 0, correct: false });
});

test('gradeMultiChoice: empty selection gives 0', () => {
    const q = { correctAnswers: [{ text: 'A' }] };
    assert.deepEqual(gradeMultiChoice([], q), { points: 0, correct: false });
    assert.deepEqual(gradeMultiChoice(null, q), { points: 0, correct: false });
});

test('sanitizeStudentId strips Firebase-illegal characters and whitespace', () => {
    assert.equal(sanitizeStudentId(' 6501.02#03$04[05]06/07 '), '6501_02_03_04_05_06_07');
    assert.equal(sanitizeStudentId('STD 123'), 'STD_123');
    assert.equal(sanitizeStudentId('ึ700'), '700');
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

test('canStudentSeeAnswerKey requires attempt or assignment to be released and not in_progress', () => {
    const metaOpen = { closesAt: 2000, resultsReleasedAll: false };
    assert.equal(canStudentSeeAnswerKey(metaOpen, { released: false }), false);
    assert.equal(canStudentSeeAnswerKey(metaOpen, { released: true }), true);
    assert.equal(canStudentSeeAnswerKey({ closesAt: 2000, resultsReleasedAll: true }, { released: false }), true);
    assert.equal(canStudentSeeAnswerKey({ closesAt: 2000, resultsReleasedAll: true }, { status: 'in_progress', released: true }), false);
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


test('summarizeGradingReason strips AI chain-of-thought and condenses verbose phrasing', () => {
    const shortRes = summarizeGradingReason('ตรงความหมาย (แมงดาทะเล)', 85);
    assert.equal(shortRes.summary, 'ตรงความหมาย (แมงดาทะเล)');
    assert.equal(shortRes.isTruncated, false);

    const longReason = "The student wrote 'tetadotoxin' which is a misspelling of 'Tetrodotoxin'. While the intent is clear, let's look closer: t-e-t-r-o-d-o-t-o-x-i-n vs t-e-t-a-d-o-t-o-x-i-n. Actually, I will assign partial.";
    const longRes = summarizeGradingReason(longReason, 85);
    assert.equal(longRes.summary, "'tetadotoxin' → สะกดผิดจาก 'Tetrodotoxin'");
    assert.equal(longRes.isTruncated, false);
});

test('buildConceptBreakdownItems extracts matched student phrases even from legacy reasons', () => {
    const q = {
        type: 'typing',
        acceptedAnswers: [
            { text: 'Tetrodotoxin', points: 10 },
            { text: 'Horseshoe crab ingestion', points: 10 },
            { text: 'Blue ring octopus', points: 10 }
        ]
    };
    const legacyEntry = {
        autoPoints: 50,
        aiConcepts: [
            { conceptId: 1, tier: 'partial', points: 5, reason: "The student wrote 'tetadotoxin' which is a misspelling of 'Tetrodotoxin'." },
            { conceptId: 2, tier: 'full', points: 10, reason: "The student provided 'แมงดาทะเล' (Horseshoe crab) which is the correct Thai term for the source of the toxin in this context." },
            { conceptId: 3, tier: 'none', points: 0, reason: "The student did not mention Blue ring octopus." }
        ]
    };

    const res = buildConceptBreakdownItems(q, legacyEntry, null, 'tetadotoxin แมงดาทะเล');
    assert.equal(res.items.length, 3);
    assert.equal(res.earnedRubricPts, 15);
    assert.equal(res.maxRubricPts, 30);
    assert.equal(res.normalizedScore, 50);
    assert.equal(res.fullCount, 1);
    assert.equal(res.partialCount, 1);
    assert.equal(res.noneCount, 1);
    assert.equal(res.items[0].keyText, 'Tetrodotoxin');
    assert.equal(res.items[0].matched, 'tetadotoxin');
    assert.equal(res.items[1].matched, 'แมงดาทะเล');
    assert.equal(res.items[2].tier, 'none');
    assert.equal(res.items[2].reasonSummary, 'ไม่ได้ระบุ Blue ring octopus');

    // Local fallback when aiConcepts is absent
    const localRes = buildConceptBreakdownItems(
        q,
        { autoPoints: 33 },
        [
            { text: 'Tetrodotoxin', pts: 10, matched: false, matchedSyn: null },
            { text: 'Horseshoe crab ingestion', pts: 10, matched: true, matchedSyn: 'horseshoe crab' },
            { text: 'Blue ring octopus', pts: 10, matched: false, matchedSyn: null }
        ],
        'horseshoe crab'
    );
    assert.equal(localRes.fullCount, 1);
    assert.equal(localRes.noneCount, 2);
    assert.equal(localRes.items[1].matched, 'horseshoe crab');
});
