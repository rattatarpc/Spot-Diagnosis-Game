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

    return { createId, downloadJson, downloadResultsCsv, gradeMultiChoice, levenshteinDistance };
})();

if (typeof window !== 'undefined') window.AppServices = AppServices;
if (typeof module !== 'undefined') module.exports = AppServices;
