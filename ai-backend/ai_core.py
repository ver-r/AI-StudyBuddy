# ai_core.py
import os
import re
import json
import random
import hashlib
from typing import List, Optional

from dotenv import load_dotenv

# Chroma + embeddings
from langchain_community.vectorstores import Chroma
from langchain_community.embeddings import HuggingFaceEmbeddings

# Groq SDK
from groq import Groq

# --------- ENV + CLIENTS ----------
load_dotenv()
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("Please set GROQ_API_KEY in ai-backend/.env (GROQ_API_KEY=...)")

client = Groq(api_key=GROQ_API_KEY)

embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")

# NOTE: this expects ./chroma_db folder to exist beside this file
vector_store = Chroma(
    collection_name="nsc",
    embedding_function=embeddings,
    persist_directory="./chroma_db"
)


# ai_core.py

from langchain_community.document_loaders import PyPDFLoader
import os

# ... existing GROQ / embeddings / vector_store setup ...

def ingest_pdf(path: str) -> int:
    """
    Load a PDF from disk, split into pages, and add page texts
    into the existing Chroma vector_store.

    Returns number of pages ingested.
    """
    if not os.path.exists(path):
        raise FileNotFoundError(f"PDF not found: {path}")

    loader = PyPDFLoader(path)
    docs = loader.load()  # list of Documents, one per page (for PyPDFLoader)

    texts = [d.page_content for d in docs]
    metadatas = [{"source": path, "page": i} for i in range(len(texts))]

    # let Chroma generate IDs automatically
    vector_store.add_texts(texts=texts, metadatas=metadatas)
    return len(texts)


# --------- HELPERS ----------
def hash_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def _safe_groq_call(
    messages: List[dict],
    model: str = "llama-3.1-8b-instant",
    context: Optional[str] = None,
    max_completion_tokens: int = 1024,
    temperature: float = 0.2
) -> str:
    try:
        if context:
            context_msg = {
                "role": "system",
                "content": (
                    "ONLY use the provided CONTEXT to answer the user's requests. "
                    "If the answer is not in the context, say: \"I can't find that in your notes.\" "
                    "CONTEXT START:\n\n" + context + "\n\nCONTEXT END"
                )
            }
            messages = [context_msg] + messages

        completion = client.chat.completions.create(
            model=model,
            messages=messages,
            max_completion_tokens=max_completion_tokens,
            temperature=temperature,
        )
        return completion.choices[0].message.content
    except Exception as e:
        return f"ERROR_IN_GROQ: {str(e)}"

# --------- VECTORSTORE HELPERS ----------
def fetch_all_documents_from_chroma() -> List[str]:
    try:
        coll = getattr(vector_store, "_collection", None)
        if coll is not None:
            try:
                data = coll.get(include=["documents"])
                docs = data.get("documents", [])
                if docs:
                    return docs
            except Exception:
                try:
                    data = coll.get()
                    docs = data.get("documents", []) if isinstance(data, dict) else []
                    if docs:
                        return docs
                except Exception:
                    pass
    except Exception:
        pass

    try:
        docs = vector_store.similarity_search(" ", k=1000)
        return [d.page_content for d in docs]
    except Exception:
        return []

def retrieve_context_for_topic(topic: str, k: int = 6) -> List[str]:
    try:
        docs = vector_store.similarity_search(topic, k=k)
        return [d.page_content for d in docs]
    except Exception:
        return []

# --------- QUIZ LOGIC ----------
def generate_question_rag(topic: str, difficulty: str, used_questions_texts: List[str] | None = None) -> str:
    if used_questions_texts is None:
        used_questions_texts = []

    docs = retrieve_context_for_topic(topic, k=6)
    context = "\n\n".join(docs) if docs else ""

    difficulty_instruction = {
        "Easy":   "Create a simple recall-based MCQ about a concrete fact. Keep wording simple.",
        "Medium": "Create a conceptual MCQ that tests understanding, not mere recall.",
        "Hard":   "Create an analytical/application MCQ that requires reasoning from the context."
    }[difficulty]

    used_json = json.dumps(used_questions_texts[-10:])

    prompt_user = f"""
You are an ASSISTANT that must output EXACTLY one multiple-choice question in this strict format.
Do not add anything else.

Difficulty: {difficulty}
Instruction: {difficulty_instruction}

ADDITIONAL RULES:
- DO NOT repeat any question present in this JSON list (most recent first): {used_json}
- Randomize which letter (a/b/c/d) is the correct option.
- The correct option must be supported by the CONTEXT provided.
- Provide plausible distractors for other options.
- Output must use this exact format (with newlines):
Question: <your question text>
a) <option a text>
b) <option b text>
c) <option c text>
d) <option d text>
Correct: <a|b|c|d>

Context:
(Use only the context to generate the question.)
"""
    messages = [{"role": "user", "content": prompt_user}]
    return _safe_groq_call(messages=messages, context=context, temperature=0.2, max_completion_tokens=512)

def parse_question_response(response: str) -> dict:
    q = {"question": "", "a": "", "b": "", "c": "", "d": "", "correct": ""}

    if not response or response.startswith("ERROR_IN_GROQ"):
        return q

    text = response.strip()

    m_q = re.search(r"Question:\s*(.+?)(?=\n[a-d]\)|\nCorrect:|\Z)", text, flags=re.IGNORECASE | re.DOTALL)
    if m_q:
        q["question"] = m_q.group(1).strip()

    option_pattern = re.compile(
        r"(?m)^[ \t]*([abcd])\)\s*(.+?)(?=(?:\n[abcd]\)|\nCorrect:|\Z))",
        flags=re.IGNORECASE | re.DOTALL
    )
    for om in option_pattern.finditer(text):
        label = om.group(1).lower()
        val = om.group(2).strip()
        q[label] = re.sub(r"\s+\n\s+", " ", val)

    m_corr = re.search(r"Correct:\s*([a-dA-D])", text, flags=re.IGNORECASE)
    if m_corr:
        q["correct"] = m_corr.group(1).lower()

    if not (q["a"] and q["b"] and q["c"] and q["d"] and q["question"]):
        return q

    if not q["correct"]:
        q["correct"] = random.choice(["a", "b", "c", "d"])

    labels = ["a", "b", "c", "d"]
    option_texts = [q[l] for l in labels]
    correct_text = q[q["correct"]]

    pairs = list(zip(labels, option_texts))
    random.shuffle(pairs)
    new_map = {}
    new_correct_label = None
    for idx, (_, opt_text) in enumerate(pairs):
        lbl = labels[idx]
        new_map[lbl] = opt_text
        if opt_text == correct_text:
            new_correct_label = lbl

    q["a"], q["b"], q["c"], q["d"] = new_map["a"], new_map["b"], new_map["c"], new_map["d"]
    q["correct"] = new_correct_label or random.choice(labels)
    return q

def validate_question_data(q: dict) -> bool:
    return bool(q.get("question") and q.get("a") and q.get("b") and q.get("c") and q.get("d") and q.get("correct"))

def check_answer(question_data: dict, user_answer: str) -> bool:
    try:
        return user_answer.lower() == question_data["correct"].lower()
    except Exception:
        return False

# --------- DOUBT SOLVER ----------
FOLLOW_UP_PHRASES = [
    "explain better", "explain again", "simplify", "in better words",
    "clarify", "make it simpler", "explain more", "expand", "elaborate"
]

def solve_doubt(question: str, last_answer: str = "") -> str:
    docs = retrieve_context_for_topic(question, k=8)
    context = "\n\n".join(docs) if docs else ""

    lower_q = question.lower().strip()
    is_follow_up = any(phrase in lower_q for phrase in FOLLOW_UP_PHRASES) and bool(last_answer)

    if is_follow_up:
        prompt = f"""
You are a tutor. The user previously asked and you answered:

Previous assistant answer:
{last_answer}

Now the user asks (follow-up): {question}

Task: Improve, clarify, or simplify the previous answer. Correct any errors if present.
Keep it concise (2-4 sentences).
"""
    else:
        prompt = f"""
You are a helpful tutor. Use the provided context (if any) to answer the user's question concisely.
If the answer is not present in the context, say: "I can't find that in your notes."
User Question: {question}

Answer in 2-4 sentences and, when helpful, give one brief supporting detail or example.
"""
    messages = [{"role": "user", "content": prompt}]
    return _safe_groq_call(messages=messages, context=context, temperature=0.2, max_completion_tokens=512)

# --------- SUMMARIZER ----------
def summarize_notes(mode: str = "Detailed") -> str:
    docs_texts = fetch_all_documents_from_chroma()
    if not docs_texts:
        return "No notes found in the database."

    full_text = "\n\n".join(docs_texts)

    max_chunk_chars = 4000
    chunks: list[str] = []
    text = full_text

    while len(text) > max_chunk_chars:
        split_pos = text.rfind("\n", 0, max_chunk_chars)
        if split_pos == -1:
            split_pos = max_chunk_chars
        chunks.append(text[:split_pos])
        text = text[split_pos:]
    if text:
        chunks.append(text)

    chunk_summaries: list[str] = []
    for i, chunk in enumerate(chunks):
        prompt = f"""
You are an expert summarizer. Summarize the following text into 3–5 concise bullets.
Text:
{chunk}
"""
        summary = _safe_groq_call(
            messages=[{"role": "user", "content": prompt}],
            max_completion_tokens=500,
            temperature=0.2
        )
        chunk_summaries.append(f"Chunk {i+1} Summary:\n{summary}")

    combined = "\n\n".join(chunk_summaries)

    if mode == "Brief":
        final_instruction = "Create a brief summary containing exactly 5 bullet points."
    else:
        final_instruction = (
            "Create a detailed structured summary with headings and subpoints. "
            "Include major themes, key definitions, important examples, and explanations."
        )

    final_prompt = f"""
You are an expert summarizer.

Here are summaries of all chunks:
{combined}

TASK:
{final_instruction}

Write the final summary below:
"""

    final_summary = _safe_groq_call(
        messages=[{"role": "user", "content": final_prompt}],
        max_completion_tokens=800,
        temperature=0.2
    )
    return final_summary
