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
    // Each correct choice is worth 20 pts. Selecting ANY wrong choice gives 0.
    // Selecting ALL correct choices (and no wrong ones) adds a +50 bonus.
    // answer may be a single value (legacy) or an array of selected choices.
    function gradeMultiChoice(answer, q) {
        const correctSet = new Set((q.correctAnswers || (q.correctAnswer ? [q.correctAnswer] : [])).map(c =>
            typeof c === 'string' ? c : c.text
        ));
        const selected = Array.isArray(answer) ? answer : (answer == null ? [] : [answer]);

        if (selected.length === 0) return { points: 0, correct: false };

        let points = 0;
        let wrong = false;
        for (const sel of selected) {
            if (correctSet.has(sel)) {
                points += 20;
            } else {
                wrong = true;
            }
        }
        if (wrong) return { points: 0, correct: false };

        const allCorrectSelected = correctSet.size > 0 && selected.length === correctSet.size;
        if (allCorrectSelected) points += 50; // bonus

        return { points, correct: points > 0 };
    }

    // ── Offline / Self-paced Assignment pure helpers ───────────────────────

    // Firebase Realtime DB keys cannot contain . # $ [ ] / or control chars.
    function sanitizeStudentId(raw) {
        return String(raw ?? '')
            .trim()
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

    // Answer key visibility rule (Spec #7):
    // Answer keys & correct options are shown to a student ONLY when their
    // attempt (or the whole assignment) is released AND the assignment is closed.
    function canStudentSeeAnswerKey(meta = {}, attempt = {}, nowMs = Date.now()) {
        const isReleased = Boolean(meta.resultsReleasedAll || attempt.released);
        if (!isReleased) return false;
        const closesAt = meta.closesAt ? Number(meta.closesAt) : null;
        if (closesAt && nowMs < closesAt) return false;
        if (!closesAt && !meta.closedManually) return false;
        return true;
    }

    function isAttemptReleased(meta = {}, attempt = {}) {
        return Boolean(meta.resultsReleasedAll || attempt.released);
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
        computeAttemptTotalScore,
        buildOfflineAttemptsCsv,
        downloadOfflineAttemptsCsv
    };
})();

if (typeof window !== 'undefined') window.AppServices = AppServices;
if (typeof module !== 'undefined') module.exports = AppServices;
