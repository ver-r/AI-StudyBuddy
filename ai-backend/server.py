# server.py
import os
from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel

from ai_core import (
    generate_question_rag,
    parse_question_response,
    validate_question_data,
    solve_doubt,
    summarize_notes,
    ingest_pdf,
)

app = FastAPI(title="StudyBuddy AI Backend")

class QuizRequest(BaseModel):
    topic: str
    difficulty: str = "Medium"  # Easy / Medium / Hard
    num_questions: int = 5

class DoubtRequest(BaseModel):
    question: str
    last_answer: Optional[str] = ""

class SummaryRequest(BaseModel):
    mode: str = "Detailed"  # "Brief" or "Detailed"

class IngestRequest(BaseModel):
    path : str

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/ingest")
def ingest(req: IngestRequest):
    """
    Ingest a local PDF into Chroma using its filesystem path.
    Electron will give us this path.
    """
    pages = ingest_pdf(req.path)
    return {"ok": True, "pages": pages, "path": req.path}

@app.post("/quiz")
def quiz(req: QuizRequest):
    used_questions_texts: List[str] = []
    questions: List[dict] = []

    for _ in range(req.num_questions):
        max_attempts = 8
        for _attempt in range(max_attempts):
            raw = generate_question_rag(req.topic, req.difficulty, used_questions_texts)
            parsed = parse_question_response(raw)
            if not validate_question_data(parsed):
                continue
            if parsed["question"].strip() in used_questions_texts:
                continue
            used_questions_texts.append(parsed["question"].strip())
            questions.append(parsed)
            break

    if not questions:
        return {"ok": False, "error": "Could not generate questions. Try another topic or difficulty."}

    return {"ok": True, "topic": req.topic, "questions": questions}

@app.post("/doubt")
def doubt(req: DoubtRequest):
    answer = solve_doubt(req.question, last_answer=req.last_answer or "")
    return {"ok": True, "answer": answer}

@app.post("/summarize")
def summarize(req: SummaryRequest):
    mode = "Brief" if req.mode.lower().startswith("brief") else "Detailed"
    text = summarize_notes(mode=mode)
    return {"ok": True, "summary": text}

if __name__ == "__main__":
    port = int(os.environ.get("AI_PORT", "8000"))
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=port)
