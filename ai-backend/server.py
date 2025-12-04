# server.py
import os
from typing import List, Optional
import uuid
import threading
from fastapi import FastAPI
from pydantic import BaseModel
jobs = {}

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
    
def run_summary(job_id: str, mode: str):
    try:
        result = summarize_notes(mode)
        jobs[job_id] = {"status": "done", "result": result}
    except Exception as e:
        jobs[job_id] = {"status": "error", "result": str(e)}


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

@app.post("/summarize/start")
def summarize_start(req: SummaryRequest):
    mode = "Brief" if req.mode.lower().startswith("brief") else "Detailed"
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "processing", "result": ""}

    t = threading.Thread(target=run_summary, args=(job_id, mode))
    t.start()

    return {"ok": True, "job_id": job_id}
@app.get("/summarize/status/{job_id}")
def summarize_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return {"ok": False, "error": "Invalid job_id"}

    if job["status"] == "done":
        return {"ok": True, "status": "done", "summary": job["result"]}

    if job["status"] == "error":
        return {"ok": False, "status": "error", "error": job["result"]}

    return {"ok": True, "status": "processing"}


if __name__ == "__main__":
    port = int(os.environ.get("AI_PORT", "8000"))
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=port)
