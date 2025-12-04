# app_groq_rag.py
import os
import re
import json
import random
import hashlib
from typing import List, Optional

import streamlit as st
from dotenv import load_dotenv

# Chroma + embeddings (same as your setup)
from langchain_community.vectorstores import Chroma
from langchain_community.embeddings import HuggingFaceEmbeddings

# Groq SDK
from groq import Groq

# -------------------------
# Load env & init clients
# -------------------------
load_dotenv()
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise RuntimeError("Please set GROQ_API_KEY in your environment (.env)")

# Initialize Groq client
client = Groq(api_key=GROQ_API_KEY)

# Embeddings & Chroma vectorstore (points to your existing local DB)
embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")

vector_store = Chroma(
    collection_name="nsc",               # your collection name
    embedding_function=embeddings,
    persist_directory="./chroma_db"
)

# -------------------------
# Helpers
# -------------------------
def hash_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def _safe_groq_call(messages: List[dict], model: str = "llama-3.1-8b-instant",
                    context: Optional[str] = None,
                    max_completion_tokens: int = 1024,
                    temperature: float = 0.2) -> str:
    """
    Core Groq invocation wrapper.
    messages: list of {"role": "system"/"user"/"assistant", "content": "..."}
    context: optional context string to include explicitly (RAG)
    """
    try:
        # If context is provided, add it as a system message instructing the model to only use it
        if context:
            context_msg = {
                "role": "system",
                "content": (
                    "ONLY use the provided CONTEXT to answer the user's requests. "
                    "If the answer is not in the context, say: \"I can't find that in your notes.\" "
                    "CONTEXT START:\n\n" + context + "\n\nCONTEXT END"
                )
            }
            # Put context as the first message so model sees it
            messages = [context_msg] + messages

        completion = client.chat.completions.create(
            model=model,
            messages=messages,
            max_completion_tokens=max_completion_tokens,
            temperature=temperature,
            # stream=False is default; you can enable streaming later if desired
        )
        return completion.choices[0].message.content
    except Exception as e:
        return f"ERROR_IN_GROQ: {str(e)}"

# -------------------------
# Document retrieval helpers
# -------------------------
def fetch_all_documents_from_chroma() -> List[str]:
    """
    Try to fetch all documents; fallback to a wide similarity search.
    """
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
    """
    Return top-k chunk texts for the topic using Chroma similarity search.
    """
    try:
        docs = vector_store.similarity_search(topic, k=k)
        return [d.page_content for d in docs]
    except Exception:
        return []

# -------------------------
# Question generation logic
# -------------------------
def generate_question_rag(topic: str, difficulty: str, used_questions_texts: List[str]=None) -> str:
    """
    Use RAG: retrieve top chunks for topic and ask Groq to produce exactly one MCQ
    in the strict format that your parser expects.
    Returns raw LLM output (string).
    """
    if used_questions_texts is None:
        used_questions_texts = []

    docs = retrieve_context_for_topic(topic, k=6)
    context = "\n\n".join(docs) if docs else ""

    difficulty_instruction = {
        "Easy": "Create a simple recall-based MCQ about a concrete fact. Keep wording simple.",
        "Medium": "Create a conceptual MCQ that tests understanding, not mere recall.",
        "Hard": "Create an analytical/application MCQ that requires reasoning from the context."
    }[difficulty]

    used_json = json.dumps(used_questions_texts[-10:])  # last 10

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
    # We'll ask Groq via _safe_groq_call — pass the prompt as a user message and the context separately
    messages = [
        {"role": "user", "content": prompt_user}
    ]
    # context variable will be passed into _safe_groq_call which prefixes it as a system message.
    return _safe_groq_call(messages=messages, context=context, temperature=0.2, max_completion_tokens=512)

# -------------------------
# Parsing / validation functions (kept from your original logic)
# -------------------------
def parse_question_response(response: str) -> dict:
    q = {"question": "", "a": "", "b": "", "c": "", "d": "", "correct": ""}

    if not response or response.startswith("ERROR_IN_GROQ"):
        return q

    text = response.strip()

    m_q = re.search(r"Question:\s*(.+?)(?=\n[a-d]\)|\nCorrect:|\Z)", text, flags=re.IGNORECASE | re.DOTALL)
    if m_q:
        q["question"] = m_q.group(1).strip()

    option_pattern = re.compile(r"(?m)^[ \t]*([abcd])\)\s*(.+?)(?=(?:\n[abcd]\)|\nCorrect:|\Z))", flags=re.IGNORECASE | re.DOTALL)
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

    # Shuffle options client-side
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
    if new_correct_label:
        q["correct"] = new_correct_label
    else:
        q["correct"] = random.choice(labels)

    return q

def validate_question_data(q: dict) -> bool:
    return bool(q.get("question") and q.get("a") and q.get("b") and q.get("c") and q.get("d") and q.get("correct"))

def check_answer(question_data: dict, user_answer: str) -> bool:
    try:
        return user_answer.lower() == question_data["correct"].lower()
    except Exception:
        return False

# -------------------------
# Doubt solver & summarizer
# -------------------------
FOLLOW_UP_PHRASES = [
    "explain better", "explain again", "simplify", "in better words",
    "clarify", "make it simpler", "explain more", "expand", "elaborate"
]

def solve_doubt(question: str, last_answer: str = "") -> str:
    """
    RAG-powered doubt solver.
    If question looks like follow-up and last_answer provided, ask Groq to improve/clarify it.
    """
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
def summarize_notes(mode: str = "Detailed") -> str:
    """
    Hierarchical (chunked) summarization to avoid token limit issues.
    1. Break large text into smaller chunks.
    2. Summarize each chunk individually.
    3. Summarize all chunk-summaries into a final brief/detailed summary.
    """

    docs_texts = fetch_all_documents_from_chroma()
    if not docs_texts:
        return "No notes found in the database."

    full_text = "\n\n".join(docs_texts)

    # -------------------------
    # STEP 1: Chunk the document
    # -------------------------
    max_chunk_chars = 4000     # safe chunk size for free Groq usage
    chunks = []
    text = full_text

    while len(text) > max_chunk_chars:
        # Cut at last newline before chunk boundary
        split_pos = text.rfind("\n", 0, max_chunk_chars)
        if split_pos == -1:
            split_pos = max_chunk_chars
        chunks.append(text[:split_pos])
        text = text[split_pos:]
    if text:
        chunks.append(text)

    # -------------------------
    # STEP 2: Summarize each chunk individually
    # -------------------------
    chunk_summaries = []

    for i, chunk in enumerate(chunks):
        with st.spinner(f"Summarizing chunk {i+1}/{len(chunks)}..."):
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
        chunk_summaries.append(f"Chunk {i+1} Summary:\n" + summary)

    # -------------------------
    # STEP 3: Combine all summaries + Final Summary
    # -------------------------
    combined = "\n\n".join(chunk_summaries)

    if mode == "Brief":
        final_instruction = (
            "Create a brief summary containing exactly 5 bullet points."
        )
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

# -------------------------
# Streamlit UI
# -------------------------
def main():
    st.set_page_config(page_title="Groq RAG Learning Assistant", layout="centered")
    st.title("📚 Groq + RAG Learning Assistant")

    st.sidebar.title("Navigation")
    app_mode = st.sidebar.selectbox(
        "Choose a feature:",
        ["Quiz (topic RAG)", "Doubt Solver", "Notes Summarizer"]
    )

    # session state
    if "quiz_started" not in st.session_state:
        st.session_state.quiz_started = False
    if "current_question" not in st.session_state:
        st.session_state.current_question = 0
    if "questions" not in st.session_state:
        st.session_state.questions = []
    if "user_answers" not in st.session_state:
        st.session_state.user_answers = []
    if "used_hashes" not in st.session_state:
        st.session_state.used_hashes = []
    if "used_questions_texts" not in st.session_state:
        st.session_state.used_questions_texts = []
    if "quiz_complete" not in st.session_state:
        st.session_state.quiz_complete = False
    if "doubt_messages" not in st.session_state:
        st.session_state.doubt_messages = []
    if "doubt_last_answer" not in st.session_state:
        st.session_state.doubt_last_answer = ""

    FIXED_NUM_QUESTIONS = 5

    # -----------------------
    if app_mode == "Quiz (topic RAG)":
        st.header("Quiz Generator — Topic-based (RAG)")
        topic = st.text_input("Enter topic (e.g. 'thermodynamics conduction')", key="topic_input")
        difficulty = st.selectbox("Select difficulty:", ["Easy", "Medium", "Hard"], index=1)
        st.write("This mode retrieves top relevant chunks for the *topic* and generates MCQs from that context.")

        if not st.session_state.quiz_started:
            st.write(f"Click to start a {FIXED_NUM_QUESTIONS}-question quiz (topic: your input).")
            if st.button("Start Quiz"):
                if not topic.strip():
                    st.error("Please enter a topic first.")
                else:
                    st.session_state.quiz_started = True
                    st.session_state.current_question = 0
                    st.session_state.questions = []
                    st.session_state.user_answers = []
                    st.session_state.used_hashes = []
                    st.session_state.used_questions_texts = []
                    st.session_state.quiz_complete = False
                    st.rerun()

        elif st.session_state.quiz_started and not st.session_state.quiz_complete:
            st.write(f"**Question {st.session_state.current_question + 1} of {FIXED_NUM_QUESTIONS}**")

            # generate a new question if needed
            if st.session_state.current_question >= len(st.session_state.questions):
                with st.spinner("Generating question..."):
                    max_attempts = 10
                    for attempt in range(max_attempts):
                        raw = generate_question_rag(topic, difficulty, st.session_state.used_questions_texts)
                        parsed = parse_question_response(raw)

                        if not validate_question_data(parsed):
                            continue

                        qhash = hash_text(parsed["question"])
                        if qhash in st.session_state.used_hashes or parsed["question"].strip() in st.session_state.used_questions_texts:
                            continue

                        # accept
                        st.session_state.questions.append(parsed)
                        st.session_state.used_hashes.append(qhash)
                        st.session_state.used_questions_texts.append(parsed["question"].strip())
                        break
                    else:
                        st.error("Couldn't generate a valid, unique question. Try changing topic or difficulty.")
                        return

            # display
            current_q = st.session_state.questions[st.session_state.current_question]
            st.subheader(current_q["question"])
            opts = ["a", "b", "c", "d"]
            user_choice = st.radio(
                "Select your answer:",
                opts,
                format_func=lambda x: f"{x}) {current_q.get(x, '')}"
            )

            if st.button("Submit Answer"):
                is_correct = check_answer(current_q, user_choice)
                st.session_state.user_answers.append({
                    "question": current_q["question"],
                    "user_answer": user_choice,
                    "correct_answer": current_q["correct"],
                    "is_correct": is_correct
                })
                if is_correct:
                    st.success("Correct! 🎉")
                else:
                    st.error(f"Incorrect. Correct answer: {current_q['correct'].upper()}")

                st.session_state.current_question += 1
                if st.session_state.current_question >= FIXED_NUM_QUESTIONS:
                    st.session_state.quiz_complete = True
                st.rerun()

        elif st.session_state.quiz_complete:
            st.header("Quiz Complete!")
            score = sum(1 for x in st.session_state.user_answers if x["is_correct"])
            st.subheader(f"Score: {score}/{len(st.session_state.user_answers)}")

            st.write("### Results")
            for i, rec in enumerate(st.session_state.user_answers, start=1):
                with st.expander(f"Q{i}: {rec['question'][:80]}..."):
                    st.write(f"**Your answer:** {rec['user_answer'].upper()} => {st.session_state.questions[i-1].get(rec['user_answer'], '')}")
                    st.write(f"**Correct:** {rec['correct_answer'].upper()} => {st.session_state.questions[i-1].get(rec['correct_answer'], '')}")
                    if rec["is_correct"]:
                        st.success("✓ Correct")
                    else:
                        st.error("✗ Incorrect")

            if st.button("Get performance feedback"):
                fb_prompt = f"The user scored {score}/{len(st.session_state.user_answers)} on a quiz about '{topic}'. Provide 2-3 sentence constructive feedback, positive tone, mention which areas to focus on."
                fb = _safe_groq_call(messages=[{"role":"user","content":fb_prompt}], context="\n\n".join(retrieve_context_for_topic(topic, k=8)))
                st.write(fb)

            if st.button("Start New Quiz"):
                st.session_state.quiz_started = False
                st.session_state.quiz_complete = False
                st.session_state.questions = []
                st.session_state.user_answers = []
                st.session_state.used_hashes = []
                st.session_state.used_questions_texts = []
                st.rerun()

    # -----------------------
    elif app_mode == "Doubt Solver":
        st.header("❓ Doubt Solver (RAG)")
        for msg in st.session_state.doubt_messages:
            if msg["role"] == "user":
                with st.chat_message("user"):
                    st.markdown(msg["content"])
            else:
                with st.chat_message("assistant"):
                    st.markdown(msg["content"])

        prompt = st.chat_input("Ask a question (or say 'explain better' to refine the last answer):")
        if prompt:
            st.session_state.doubt_messages.append({"role": "user", "content": prompt})
            with st.spinner("Searching notes and answering..."):
                ans = solve_doubt(prompt, last_answer=st.session_state.get("doubt_last_answer", ""))
            st.session_state.doubt_messages.append({"role": "assistant", "content": ans})
            st.session_state.doubt_last_answer = ans
            st.rerun()

        if st.button("Clear Conversation"):
            st.session_state.doubt_messages = []
            st.session_state.doubt_last_answer = ""
            st.rerun()

    # -----------------------
    elif app_mode == "Notes Summarizer":
        st.header("📝 Notes Summarizer")
        summary_level = st.radio("Summary level:", ["Brief", "Detailed"])
        if st.button("Summarize Notes"):
            with st.spinner("Preparing summary from all notes..."):
                s = summarize_notes("Brief" if summary_level == "Brief" else "Detailed")
            st.subheader("Summary")
            st.write(s)
            st.download_button("Download summary", s, "summary.txt", "text/plain")

    st.markdown("---")
    st.caption("Tip: For topic quizzes, type a narrow topic (e.g., 'thermodynamics conduction') for focused questions.")

if __name__ == "__main__":
    main()
