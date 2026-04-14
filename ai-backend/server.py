# server.py
import os
from typing import List, Optional
import uuid
import threading
from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
from pydantic import BaseModel
from typing import List, Optional, Dict
from datetime import datetime
import sys
import os

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from Emotion_Behavior.attentiveORdistracted_copy import run_attentiveness_check
                
jobs = {}

from ai_core import (
    generate_single_question,
    check_answer,
    solve_doubt,
    summarize_notes,
    ingest_pdf,
)

app = FastAPI(title="StudyBuddy AI Backend")


class QuizRequest(BaseModel):
    topic: str
    difficulty: str = "Medium"
    num_questions: int = 5


class CheckAnswerRequest(BaseModel):
    question_data: dict
    user_answer: str


class DoubtRequest(BaseModel):
    question: str
    last_answer: Optional[str] = ""


class SummaryRequest(BaseModel):
    mode: str = "Detailed"
    source: Optional[str] = None

class IngestRequest(BaseModel):
    path: str

class AnalysticsRequest(BaseModel):
    sessions:List[dict]
    quiz_history:List[dict]
    emotion_history:List[dict]

def run_summary(job_id: str, mode: str, source: str):
    try:
        result = summarize_notes(mode, source)
        jobs[job_id] = {"status": "done", "result": result}
    except Exception as e:
        jobs[job_id] = {"status": "error", "result": str(e)}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ingest")
def ingest(req: IngestRequest):
    pages = ingest_pdf(req.path)
    return {"ok": True, "pages": pages, "path": req.path}


@app.post("/quiz")
def quiz(req: QuizRequest):
    if req.difficulty not in ["Easy", "Medium", "Hard"]:
        return {"ok": False, "error": "Invalid difficulty"}

    if len(req.topic.strip()) < 2:
        return {"ok": False, "error": "Topic too short"}

    used_questions = []
    questions = []

    for _ in range(req.num_questions):
        q = generate_single_question(req.topic, req.difficulty, used_questions)
        if q:
            used_questions.append(q["question"].strip())
            questions.append(q)

    if not questions:
        return {"ok": False, "error": "No questions could be generated"}

    return {"ok": True, "questions": questions}


@app.post("/quiz/check")
def quiz_check(req: CheckAnswerRequest):
    correct = check_answer(req.question_data, req.user_answer)
    return {"ok": True, "correct": correct}


@app.post("/doubt")
def doubt(req: DoubtRequest):
    answer = solve_doubt(req.question, last_answer=req.last_answer or "")
    return {"ok": True, "answer": answer}


@app.post("/summarize/start")
def summarize_start(req: SummaryRequest):
    mode = "Brief" if req.mode.lower().startswith("brief") else "Detailed"
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "processing", "result": ""}

    t = threading.Thread(target=run_summary, args=(job_id, mode, req.source))
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
@app.post("/attentive")
def run_attentive():
    return { "ok": True, **run_attentiveness_check() }

@app.post("/analytics")
def compute_analytics(req:AnalysticsRequest):
    sessions=req.sessions
    quiz_history=req.quiz_history
    emotion_history=req.emotion_history

    focus_sessions=[s for s in sessions if s.get('type')==("focus")]
    total_focus_minutes=sum(s.get("seconds", 0) for s in focus_sessions)/60
    avg_session_duration=(
        np.mean([s.get("seconds",0)for s in focus_sessions])/60
        if focus_sessions else 0
        )
    completion_rate=(
        len([s for s in focus_sessions if s.get("completed")])
        /len(focus_sessions)
        *100
        if focus_sessions else 0
    )                

    total_quizzes=len(quiz_history)
    avg_quiz_score=(
        np.mean([
            (q.get("score",0)/q.get("total", 1))*100
            for q in quiz_history if q.get("total",0)>0
        ])
        if quiz_history else 0
        
    )

    avg_attention_score=(
        np.mean([e.get("score",0) for e in emotion_history])
        if emotion_history else 0
    )

    distracted_percent = (
        len([
            e for e in emotion_history
            if str(e.get("classification", "")).lower() == "distracted"
        ]) / len(emotion_history) * 100
        if emotion_history else 0
    )

    recent_focus = focus_sessions[-7:]
    focus_trend = [
        round(s.get("seconds", 0) / 60, 2)
        for s in recent_focus
    ]

    recent_quizzes = quiz_history[-7:]
    quiz_trend = [
        round((q.get("score", 0) / q.get("total", 1)) * 100, 2)
        for q in recent_quizzes if q.get("total", 0) > 0
    ]

    attention_trend = [
        round(e.get("score", 0), 2)
        for e in emotion_history[-10:]
    ]

    return {
        "focus": {
            "total_minutes": round(total_focus_minutes, 2),
            "avg_session_minutes": round(avg_session_duration, 2),
            "completion_rate": round(completion_rate, 2),
            "trend": focus_trend
        },
        "quiz": {
            "total_quizzes": total_quizzes,
            "avg_score_percent": round(avg_quiz_score, 2),
            "trend": quiz_trend
        },
        "attention": {
            "avg_score": round(avg_attention_score, 2),
            "distracted_percent": round(distracted_percent, 2),
            "trend": attention_trend
        }
    }


if __name__ == "__main__":
    port = int(os.environ.get("AI_PORT", "8000"))
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=port)
