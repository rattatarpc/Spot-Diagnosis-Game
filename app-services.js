/* Small, dependency-free services shared by the static app. */
const AppServices = (() => {
    function createId() {
        return typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function levenshteinDistance(a, b) {
        const matrix = Array.from({ length: b.length + 1 }, (_, row) => [row]);
        for (let column = 0; column <= a.length; column++) matrix[0][column] = column;
        for (let row = 1; row <= b.length; row++) {
            for (let column = 1; column <= a.length; column++) {
                matrix[row][column] = b[row - 1] === a[column - 1]
                    ? matrix[row - 1][column - 1]
                    : Math.min(matrix[row - 1][column - 1] + 1, matrix[row][column - 1] + 1, matrix[row - 1][column] + 1);
            }
        }
        return matrix[b.length][a.length];
    }

    function download(filename, content, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }

    function downloadJson(filename, data) {
        download(filename, JSON.stringify(data, null, 2), 'application/json');
    }

    function csvCell(value) {
        return `"${String(value ?? '').replace(/"/g, '""')}"`;
    }

    function downloadResultsCsv(filename, sortedPlayers, questions = []) {
        const rows = [['Rank', 'Player', 'Score', ...questions.map((_, index) => `Q${index + 1} Points`)]];
        sortedPlayers.forEach(([name, data], index) => {
            rows.push([
                index + 1,
                name,
                data.score || 0,
                ...questions.map((_, questionIndex) => data.awardedPoints?.[questionIndex] ?? '')
            ]);
        });
        const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
        download(filename, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
    }

    // Grade a multiple-choice question that may have multiple correct answers.
    // Normalized to 100 points maximum with partial credit:
    // Net fraction = (selectedCorrect / totalCorrect) - (selectedWrong / totalWrong)
    // Points = Math.max(0, Math.min(100, Math.round(netFraction * 100)))
    function gradeMultiChoice(answer, q = {}) {
        const correctSet = new Set((q.correctAnswers || (q.correctAnswer ? [q.correctAnswer] : [])).map(c =>
            typeof c === 'string' ? c : (c.text || '')
        ));
        const selected = Array.isArray(answer) ? answer : (answer == null ? [] : [answer]);

        if (selected.length === 0 || correctSet.size === 0) return { points: 0, correct: false };

        const totalCorrect = correctSet.size;

        // Collect all available options from question
        const optionsList = Array.isArray(q.options) && q.options.length > 0
            ? q.options.map(o => typeof o === 'string' ? o : (o.text || '')).filter(t => t.length > 0)
            : [];

        // Determine wrong options count
        let totalWrong = 0;
        if (optionsList.length > 0) {
            const wrongOptions = optionsList.filter(o => !correctSet.has(o));
            totalWrong = wrongOptions.length;
        }

        let selectedCorrect = 0;
        let selectedWrong = 0;
        for (const sel of selected) {
            if (correctSet.has(sel)) {
                selectedCorrect++;
            } else {
                selectedWrong++;
            }
        }

        let netFraction = 0;
        if (totalWrong > 0) {
            netFraction = (selectedCorrect / totalCorrect) - (selectedWrong / totalWrong);
        } else {
            // Fallback if options list is not explicitly provided (e.g. minimal unit test)
            netFraction = (selectedCorrect - selectedWrong) / totalCorrect;
        }

        const fraction = Math.max(0, Math.min(1, netFraction));
        const points = Math.round(fraction * 100);

        return { points, correct: points > 0 };
    }

    // ── Offline / Self-paced Assignment pure helpers ───────────────────────

    // Firebase Realtime DB keys cannot contain . # $ [ ] / or control chars.
    // Also strips stray/accidental Thai combining vowels/tones (e.g. ึ when pressing '7' on Thai keyboard).
    function sanitizeStudentId(raw) {
        return String(raw ?? '')
            .trim()
            .replace(/(^|[^\u0E01-\u0E2E])[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]+/g, '$1')
            .replace(/[.#$[\]/\\]/g, '_')
            .replace(/\s+/g, '_');
    }

    // Simple deterministic hash (FNV-1a 64-bit split in two 32-bit lanes) so it
    // runs synchronously in both Node tests and older mobile browsers without
    // requiring a secure context for crypto.subtle.
    function hashPinSync(pin, salt = 'spot-diagnosis-v1') {
        const str = `${salt}:${String(pin ?? '').trim()}`;
        let h1 = 0x811c9dc5 >>> 0;
        let h2 = 0x01000193 >>> 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ (c + i), 0x811c9dc5) >>> 0;
        }
        return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    }

    function verifyPinSync(pin, expectedHash, salt = 'spot-diagnosis-v1') {
        if (!expectedHash) return false;
        return hashPinSync(pin, salt) === String(expectedHash);
    }

    function generateAssignCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let out = '';
        for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
    }

    function generateReviewerPin() {
        return String(Math.floor(100000 + Math.random() * 900000));
    }

    // Evaluate whether an assignment window is currently open.
    // Returns { state: 'not_open_yet' | 'open' | 'closed', now, opensAt, closesAt }
    function getAssignmentWindowState(meta = {}, nowMs = Date.now()) {
        const opensAt = meta.opensAt ? Number(meta.opensAt) : null;
        const closesAt = meta.closesAt ? Number(meta.closesAt) : null;
        if (opensAt && nowMs < opensAt) return { state: 'not_open_yet', now: nowMs, opensAt, closesAt };
        if (closesAt && nowMs >= closesAt) return { state: 'closed', now: nowMs, opensAt, closesAt };
        return { state: 'open', now: nowMs, opensAt, closesAt };
    }

    // Answer key visibility rule:
    // Answer keys & correct options are shown to a student ONLY when their
    // attempt (or the whole assignment) has been released by the instructor.
    function canStudentSeeAnswerKey(meta = {}, attempt = {}) {
        if (attempt && attempt.status === 'in_progress') return false;
        return Boolean(meta.resultsReleasedAll || attempt.released);
    }

    function isAttemptReleased(meta = {}, attempt = {}) {
        if (attempt && attempt.status === 'in_progress') return false;
        return Boolean(meta.resultsReleasedAll || attempt.released);
    }

    // Flexible lookup for an offline student attempt by Student ID and/or Name.
    // Handles exact ID, case-insensitive/numeric ID, swapped ID/Name fields, and Name-only lookup.
    // Returns { studentId, attempt } or null.
    function findMatchingOfflineAttempt(attemptsMap = {}, rawStudentId = '', rawStudentName = '', allowNameFallback = true) {
        if (!attemptsMap || typeof attemptsMap !== 'object') return null;

        const entries = Object.entries(attemptsMap).filter(([, att]) => att && typeof att === 'object');
        if (entries.length === 0) return null;

        const statusRank = (att) => {
            if (att.released || att.status === 'released') return 4;
            if (att.status === 'graded') return 3;
            if (att.status === 'submitted') return 2;
            return 1;
        };
        const sortedEntries = [...entries].sort((a, b) => {
            const rDiff = statusRank(b[1]) - statusRank(a[1]);
            if (rDiff !== 0) return rDiff;
            const tA = Number(a[1].submittedAt || a[1].lastActiveAt || a[1].startedAt || 0);
            const tB = Number(b[1].submittedAt || b[1].lastActiveAt || b[1].startedAt || 0);
            return tB - tA;
        });

        const normId = (s) => sanitizeStudentId(s).toLowerCase();
        const normName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

        const sidSanitized = sanitizeStudentId(rawStudentId);
        const sidIdNorm = normId(rawStudentId);
        const nameIdNorm = normId(rawStudentName);
        const sidNameNorm = normName(rawStudentId);
        const nameTextNorm = normName(rawStudentName);

        // 1. Exact key match on sanitized studentId
        if (sidSanitized && Object.prototype.hasOwnProperty.call(attemptsMap, sidSanitized)) {
            const direct = attemptsMap[sidSanitized];
            if (direct && typeof direct === 'object') {
                return { studentId: String(sidSanitized), attempt: direct };
            }
        }

        // 2. Case-insensitive or numeric Student ID match on rawStudentId
        if (sidIdNorm) {
            const byId = sortedEntries.find(([k, att]) =>
                normId(k) === sidIdNorm || normId(att.studentId) === sidIdNorm
            );
            if (byId) return { studentId: String(byId[0]), attempt: byId[1] };

            const trimmedId = String(rawStudentId ?? '').trim();
            if (/^\d+$/.test(trimmedId)) {
                const numVal = Number(trimmedId);
                const byNum = sortedEntries.find(([k, att]) =>
                    (/^\d+$/.test(String(k)) && Number(k) === numVal) ||
                    (/^\d+$/.test(String(att.studentId || '')) && Number(att.studentId) === numVal)
                );
                if (byNum) return { studentId: String(byNum[0]), attempt: byNum[1] };
            }
        }

        if (!allowNameFallback && sidSanitized) {
            return null;
        }

        // 3. Swapped input match: rawStudentName matches an attempt key or att.studentId
        if (nameIdNorm) {
            const bySwappedId = sortedEntries.find(([k, att]) =>
                normId(k) === nameIdNorm || normId(att.studentId) === nameIdNorm
            );
            if (bySwappedId) return { studentId: String(bySwappedId[0]), attempt: bySwappedId[1] };
        }

        // 4. Name match: rawStudentName matches att.name (case-insensitive)
        if (nameTextNorm) {
            const byName = sortedEntries.find(([, att]) => normName(att.name) === nameTextNorm);
            if (byName) return { studentId: String(byName[0]), attempt: byName[1] };
        }

        // 5. Name match on rawStudentId: user typed their Name into the Student ID box
        if (sidNameNorm) {
            const byIdAsName = sortedEntries.find(([, att]) => normName(att.name) === sidNameNorm);
            if (byIdAsName) return { studentId: String(byIdAsName[0]), attempt: byIdAsName[1] };
        }

        return null;
    }

    // Compute total score for an attempt from per-question grading entries.
    // Teacher override (teacherPoints) takes precedence over autoPoints when set.
    function computeAttemptTotalScore(grading = {}, quiz = []) {
        let total = 0;
        const count = Array.isArray(quiz) ? quiz.length : Object.keys(grading || {}).length;
        for (let i = 0; i < count; i++) {
            const q = Array.isArray(quiz) ? quiz[i] : null;
            if (q && (q.type === 'slide' || q.freePoint)) continue;
            const g = grading && grading[i];
            if (!g) continue;
            const pts = (g.teacherPoints !== undefined && g.teacherPoints !== null && g.teacherPoints !== '')
                ? Number(g.teacherPoints)
                : Number(g.autoPoints || 0);
            if (Number.isFinite(pts)) total += pts;
        }
        return total;
    }

    // Build CSV string (without BOM) for offline assignment attempts.
    function buildOfflineAttemptsCsv(quiz = [], attemptsMap = {}, meta = {}) {
        const scoredQuestions = [];
        (quiz || []).forEach((q, idx) => {
            if (q && q.type !== 'slide') scoredQuestions.push({ idx, q });
        });
        const header = [
            'Student ID',
            'Name',
            'Status',
            'Total Score',
            'Elapsed (sec)',
            'Submitted At',
            'Needs Review',
            ...scoredQuestions.flatMap(({ idx }) => [`Q${idx + 1} Answer`, `Q${idx + 1} Points`, `Q${idx + 1} Comment`]),
            'Overall Feedback'
        ];
        const rows = [header];
        const entries = Object.entries(attemptsMap || {}).sort((a, b) =>
            String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })
        );
        for (const [studentId, att] of entries) {
            if (!att) continue;
            const total = computeAttemptTotalScore(att.grading, quiz);
            const status = isAttemptReleased(meta, att) ? 'released' : (att.status || 'in_progress');
            const submittedIso = att.submittedAt ? new Date(Number(att.submittedAt)).toISOString() : '';
            const needsRev = Object.values(att.grading || {}).some(g => g && g.needsReview) ? 'YES' : '';
            const qCols = scoredQuestions.flatMap(({ idx }) => {
                const ansObj = att.answers && att.answers[idx];
                const rawVal = ansObj && typeof ansObj === 'object' && 'value' in ansObj ? ansObj.value : ansObj;
                const ansStr = Array.isArray(rawVal) ? rawVal.join(' | ') : (rawVal ?? '');
                const g = (att.grading && att.grading[idx]) || {};
                const pts = (g.teacherPoints !== undefined && g.teacherPoints !== null && g.teacherPoints !== '')
                    ? g.teacherPoints
                    : (g.autoPoints ?? '');
                return [ansStr, pts, g.comment ?? ''];
            });
            rows.push([
                studentId,
                att.name || '',
                status,
                total,
                att.elapsedSec || 0,
                submittedIso,
                needsRev,
                ...qCols,
                att.overallFeedback || ''
            ]);
        }
        return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    }

    function downloadOfflineAttemptsCsv(filename, quiz, attemptsMap, meta) {
        const csv = buildOfflineAttemptsCsv(quiz, attemptsMap, meta);
        download(filename, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
    }

    // ── Admin / Guest Gateway Verification ──────────────────────────────────
    // Default Admin credentials: Username = "Admin" (case-insensitive), Password = "00"
    const ADMIN_USER_NORM = 'admin';
    const ADMIN_PASS_HASH = hashPinSync('00', 'spot-admin-v1');

    // ── Readable Grading Breakdown Helpers ──────────────────────────────────
    function summarizeGradingReason(reason, maxLength = 85) {
        const cleaned = String(reason ?? '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return { summary: '', full: '', isTruncated: false };

        // Strip common LLM chain-of-thought self-talk sentences
        const cotPattern = /^(?:while the intent|let'?s |wait\b|but wait\b|actually\b|given the instruction|however,\s*in|usually,\s*|this looks like|it'?s a clear|it is clearly|i will (?:mark|assign)|the prompt says|no,\s*[a-z]-|'[a-z]+'\s+vs\s+'[a-z]+'|or just to be safe)/i;
        const sentences = cleaned.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
        const meaningful = sentences.filter(s => !cotPattern.test(s));
        let core = (meaningful.length > 0 ? meaningful[0] : (sentences[0] || cleaned));

        // Condense repetitive verbose phrasing into short Thai/scannable verdict
        core = core
            .replace(/^The student wrote\s+/i, '')
            .replace(/^The student provided\s+/i, '')
            .replace(/^The student mentioned\s+/i, '')
            .replace(/^The student did not mention\s+/i, 'ไม่ได้ระบุ ')
            .replace(/\s*which is a misspelling of\s*/i, ' → สะกดผิดจาก ')
            .replace(/\s*which is the correct Thai term for the source of the toxin in this context\.?$/i, ' → คำตอบตรงความหมาย')
            .replace(/\s*which is the correct Thai term for another source of\s*[^.!?]+\.?$/i, ' → คำตอบตรงความหมาย')
            .replace(/\s*which is the correct Thai term for\s*/i, ' → ตรงกับ ')
            .replace(/\s*in this context\.?$/i, '')
            .replace(/\.+$/, '')
            .trim();

        const cleanFull = meaningful.length > 0 ? meaningful.join(' ') : cleaned;
        if (core.length <= maxLength) {
            // If all remaining text was just stripped CoT noise, don't offer a noisy expand toggle
            const hasMoreMeaningful = meaningful.length > 1 && cleanFull.length > core.length + 30;
            return {
                summary: core,
                full: hasMoreMeaningful ? cleanFull : core,
                isTruncated: hasMoreMeaningful
            };
        }

        let slice = core.slice(0, maxLength);
        const lastSpace = slice.lastIndexOf(' ');
        if (lastSpace > Math.floor(maxLength * 0.55)) {
            slice = slice.slice(0, lastSpace);
        }
        return { summary: `${slice.trim()}…`, full: cleanFull, isTruncated: true };
    }

    function extractMatchedPhrase(cObj, keyText, keyResultItem, studentAnswer) {
        if (cObj?.matched && String(cObj.matched).trim()) {
            return String(cObj.matched).trim();
        }
        const ans = String(studentAnswer ?? '').trim();
        if (!ans) return '';

        const ansLower = ans.toLowerCase();
        // 1. Check quoted terms in the AI reason that actually appear in the student's answer
        const rawReason = String(cObj?.reason || '');
        const quoteRegex = /'([^'\n]{2,60})'|"([^"\n]{2,60})"/g;
        let m;
        while ((m = quoteRegex.exec(rawReason)) !== null) {
            const candidate = (m[1] || m[2] || '').trim();
            if (!candidate) continue;
            const idx = ansLower.indexOf(candidate.toLowerCase());
            if (idx !== -1) {
                return ans.slice(idx, idx + candidate.length);
            }
        }

        // 2. Fallback to local keyResults matched synonym
        if (keyResultItem?.matched && keyResultItem.matchedSyn) {
            const syn = String(keyResultItem.matchedSyn).trim();
            const idx = ansLower.indexOf(syn.toLowerCase());
            if (idx !== -1) {
                return ans.slice(idx, idx + syn.length);
            }
            return syn;
        }

        // 3. Check direct substring against key synonyms
        const syns = String(keyText || '').split('/').map(s => s.trim()).filter(Boolean);
        for (const s of syns) {
            const idx = ansLower.indexOf(s.toLowerCase());
            if (idx !== -1) {
                return ans.slice(idx, idx + s.length);
            }
        }
        return '';
    }

    function buildConceptBreakdownItems(q = {}, gradingEntry = {}, keyResults = null, studentAnswer = '') {
        let rawRubric = [];
        if (Array.isArray(q.acceptedAnswers) && q.acceptedAnswers.length > 0) {
            rawRubric = q.acceptedAnswers;
        } else if (Array.isArray(q.answerKeys) && q.answerKeys.length > 0) {
            rawRubric = q.answerKeys;
        } else if (Array.isArray(q.rubric) && q.rubric.length > 0) {
            rawRubric = q.rubric;
        } else if (q.correctAnswer) {
            rawRubric = Array.isArray(q.correctAnswer) ? q.correctAnswer : [q.correctAnswer];
        }

        const rubric = rawRubric.map((item, idx) => {
            const text = typeof item === 'string' ? item : (item?.text || item?.concept || item?.label || item?.word || '');
            const rawPts = (item && typeof item === 'object' && item.points !== undefined && item.points !== null)
                ? Number(item.points)
                : 10;
            return {
                conceptId: idx + 1,
                keyText: String(text || `Concept #${idx + 1}`),
                maxPoints: Number.isFinite(rawPts) ? rawPts : 10
            };
        }).filter(r => r.keyText.trim().length > 0);

        const aiConcepts = Array.isArray(gradingEntry?.aiConcepts) ? gradingEntry.aiConcepts : [];
        let sourceConcepts = [];
        if (aiConcepts.length > 0) {
            sourceConcepts = aiConcepts;
        } else if (Array.isArray(keyResults) && keyResults.length > 0) {
            sourceConcepts = keyResults.map((kr, idx) => ({
                conceptId: idx + 1,
                tier: kr.matched ? 'full' : 'none',
                points: kr.matched ? Number(kr.pts ?? 10) : 0,
                matched: kr.matchedSyn || '',
                reason: kr.matched ? 'ตรงกับคำตอบในเฉลย' : 'ไม่ได้ระบุคำตอบนี้'
            }));
        } else {
            return {
                items: [],
                earnedRubricPts: 0,
                maxRubricPts: rubric.reduce((s, r) => s + r.maxPoints, 0),
                normalizedScore: 0,
                fullCount: 0,
                partialCount: 0,
                noneCount: 0
            };
        }

        const byId = new Map();
        sourceConcepts.forEach(c => {
            if (c && c.conceptId !== undefined && c.conceptId !== null) {
                byId.set(Number(c.conceptId), c);
            }
        });

        const items = [];
        const seenIds = new Set();

        const pushItem = (conceptId, keyText, maxPoints, cObj, krObj) => {
            const rawTier = String(cObj?.tier || 'none').toLowerCase();
            const tier = (rawTier === 'full' || rawTier === 'partial') ? rawTier : 'none';
            const earnedPoints = Number.isFinite(Number(cObj?.points)) ? Number(cObj.points) : 0;
            const reasonInfo = summarizeGradingReason(cObj?.reason || '', 85);
            const matched = tier === 'none'
                ? ''
                : extractMatchedPhrase(cObj, keyText, krObj, studentAnswer);
            items.push({
                conceptId,
                keyText,
                maxPoints,
                earnedPoints,
                tier,
                matched,
                reasonSummary: reasonInfo.summary,
                reasonFull: reasonInfo.full,
                isReasonTruncated: reasonInfo.isTruncated
            });
        };

        rubric.forEach((r, idx) => {
            seenIds.add(r.conceptId);
            const krObj = Array.isArray(keyResults) ? keyResults[idx] : null;
            pushItem(r.conceptId, r.keyText, r.maxPoints, byId.get(r.conceptId) || { tier: 'none', points: 0 }, krObj);
        });

        sourceConcepts.forEach(c => {
            const cid = Number(c?.conceptId);
            if (!seenIds.has(cid)) {
                seenIds.add(cid);
                pushItem(cid || (items.length + 1), `Concept #${cid || (items.length + 1)}`, Number(c?.points || 10), c, null);
            }
        });

        const earnedRubricPts = items.reduce((s, it) => s + it.earnedPoints, 0);
        const maxRubricPts = items.reduce((s, it) => s + it.maxPoints, 0);
        const fullCount = items.filter(it => it.tier === 'full').length;
        const partialCount = items.filter(it => it.tier === 'partial').length;
        const noneCount = items.filter(it => it.tier === 'none').length;
        const hasTeacher = gradingEntry?.teacherPoints !== undefined && gradingEntry?.teacherPoints !== null && gradingEntry?.teacherPoints !== '';
        const normalizedScore = hasTeacher ? Number(gradingEntry.teacherPoints) : Number(gradingEntry?.autoPoints ?? 0);

        return {
            items,
            earnedRubricPts,
            maxRubricPts,
            normalizedScore,
            fullCount,
            partialCount,
            noneCount
        };
    }

    function verifyAdminCredentials(username, password) {
        const u = String(username ?? '').trim().toLowerCase();
        const p = String(password ?? '');
        if (u !== ADMIN_USER_NORM) return false;
        return hashPinSync(p, 'spot-admin-v1') === ADMIN_PASS_HASH;
    }

    return {
        createId,
        downloadJson,
        downloadResultsCsv,
        gradeMultiChoice,
        levenshteinDistance,
        sanitizeStudentId,
        hashPinSync,
        verifyPinSync,
        generateAssignCode,
        generateReviewerPin,
        getAssignmentWindowState,
        canStudentSeeAnswerKey,
        isAttemptReleased,
        findMatchingOfflineAttempt,
        computeAttemptTotalScore,
        buildOfflineAttemptsCsv,
        downloadOfflineAttemptsCsv,
        verifyAdminCredentials,
        summarizeGradingReason,
        buildConceptBreakdownItems
    };
})();

if (typeof window !== 'undefined') window.AppServices = AppServices;
if (typeof module !== 'undefined') module.exports = AppServices;
