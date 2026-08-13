const quizData = [
  {
    id: 1,
    imageUrl: "https://upload.wikimedia.org/wikipedia/commons/9/9e/12_Lead_ECG_of_a_26_year_old_male.jpg",
    clinicalContext: "26-year-old male, routine sports physical.",
    type: "multiple-choice",
    question: "What is the primary rhythm?",
    options: ["Normal Sinus Rhythm", "Atrial Fibrillation", "Sinus Tachycardia", "First-degree AV Block"],
    correctAnswer: "Normal Sinus Rhythm"
  },
  {
    id: 2,
    imageUrl: "https://upload.wikimedia.org/wikipedia/commons/9/9e/12_Lead_ECG_of_a_26_year_old_male.jpg", // Re-using for demo
    clinicalContext: "26-year-old male, routine sports physical.",
    type: "typing",
    question: "Estimate the heart rate (bpm). Type your answer:",
    correctAnswer: "70",
    acceptedAnswers: ["68", "69", "70", "71", "72"] // accept a small range
  },
  {
    id: 3,
    imageUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Sinus_tachycardia_on_ECG.png/1200px-Sinus_tachycardia_on_ECG.png",
    clinicalContext: "45-year-old female, palpitations and anxiety.",
    type: "multiple-choice",
    question: "Identify the rhythm:",
    options: ["Normal Sinus Rhythm", "Sinus Tachycardia", "Atrial Flutter", "Supraventricular Tachycardia"],
    correctAnswer: "Sinus Tachycardia"
  },
  {
    id: 4,
    imageUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Sinus_tachycardia_on_ECG.png/1200px-Sinus_tachycardia_on_ECG.png",
    clinicalContext: "45-year-old female, palpitations and anxiety.",
    type: "typing",
    question: "What is the primary finding? (Type the diagnosis)",
    correctAnswer: "sinus tachycardia",
    acceptedAnswers: ["sinus tachycardia", "tachycardia", "sinus tach"] // case-insensitive checking will be used
  }
];
