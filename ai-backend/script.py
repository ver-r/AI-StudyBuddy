import streamlit as st
from langchain_community.vectorstores import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
from langchain.chat_models import init_chat_model
from langchain.schema import HumanMessage
import re

# Initialize embeddings
embeddings = HuggingFaceEmbeddings(
    model_name="sentence-transformers/all-MiniLM-L6-v2"
)

# Initialize Chroma
vector_store = Chroma(
    collection_name="history",
    embedding_function=embeddings,
    persist_directory="./chroma_db"
)

# Initialize LLM
llm = init_chat_model("llama3.2:1b", model_provider="ollama", temperature=0)

def generate_question(topic, used_questions=None):
    """Generate a multiple choice question using RAG"""
    if used_questions is None:
        used_questions = []
    
    # Search for relevant context
    docs = vector_store.similarity_search(topic, k=3)
    context = "\n".join([doc.page_content for doc in docs])
    
    # Create prompt for question generation
    prompt = f"""
    Based on the following context about {topic}, generate ONE multiple choice question with 4 options (a, b, c, d).
    Make sure the question is clear and has one correct answer.
    
    IMPORTANT: Format your response EXACTLY like this:
    Question: [your question here]
    a) [option a]
    b) [option b]
    c) [option c]
    d) [option d]
    Correct: [letter of correct answer - only a, b, c, or d]
    
    Context: {context}
    
    Avoid these previously used questions: {used_questions}
    """
    
    try:
        response = llm.invoke([HumanMessage(content=prompt)])
        return response.content
    except Exception as e:
        return f"Error generating question: {str(e)}"

def parse_question_response(response):
    """Parse the LLM response into question structure with better error handling"""
    question_data = {
        'question': '',
        'a': '', 'b': '', 'c': '', 'd': '',
        'correct': ''
    }
    
    try:
        # Extract question
        question_match = re.search(r'Question:\s*(.+)', response, re.IGNORECASE)
        if question_match:
            question_data['question'] = question_match.group(1).strip()
        
        # Extract options
        for option in ['a', 'b', 'c', 'd']:
            option_pattern = rf'{option}\)\s*(.+)'
            option_match = re.search(option_pattern, response, re.IGNORECASE)
            if option_match:
                question_data[option] = option_match.group(1).strip()
        
        # Extract correct answer
        correct_match = re.search(r'Correct:\s*([a-d])', response, re.IGNORECASE)
        if correct_match:
            question_data['correct'] = correct_match.group(1).lower().strip()
        else:
            # Fallback: try to find any correct indicator
            correct_fallback = re.search(r'Correct:\s*(.+)', response, re.IGNORECASE)
            if correct_fallback:
                correct_text = correct_fallback.group(1).strip().lower()
                if any(opt in correct_text for opt in ['a', 'b', 'c', 'd']):
                    for opt in ['a', 'b', 'c', 'd']:
                        if opt in correct_text:
                            question_data['correct'] = opt
                            break
        
        # If still no correct answer found, set a default
        if not question_data['correct'] and question_data.get('a'):
            question_data['correct'] = 'a'  # Default to first option
            
    except Exception as e:
        st.error(f"Error parsing question: {str(e)}")
    
    return question_data

def check_answer(question_data, user_answer):
    """Check if the user's answer is correct with error handling"""
    try:
        if 'correct' in question_data and question_data['correct']:
            return user_answer.lower() == question_data['correct'].lower()
        return False
    except:
        return False

def validate_question_data(question_data):
    """Check if the question data is valid"""
    return (question_data.get('question') and 
            question_data.get('a') and 
            question_data.get('b') and 
            question_data.get('c') and 
            question_data.get('d') and 
            question_data.get('correct'))

# Streamlit app
def main():
    st.title("History Quiz Generator")
    
    # Initialize session state
    if 'quiz_started' not in st.session_state:
        st.session_state.quiz_started = False
    if 'current_question' not in st.session_state:
        st.session_state.current_question = 0
    if 'questions' not in st.session_state:
        st.session_state.questions = []
    if 'user_answers' not in st.session_state:
        st.session_state.user_answers = []
    if 'used_questions' not in st.session_state:
        st.session_state.used_questions = []
    if 'quiz_complete' not in st.session_state:
        st.session_state.quiz_complete = False
    
    # Start quiz
    if not st.session_state.quiz_started:
        st.write("Click below to start a 5-question history quiz!")
        if st.button("Start Quiz"):
            st.session_state.quiz_started = True
            st.session_state.current_question = 0
            st.session_state.questions = []
            st.session_state.user_answers = []
            st.session_state.used_questions = []
            st.session_state.quiz_complete = False
            st.rerun()
    
    # Quiz in progress
    elif st.session_state.quiz_started and not st.session_state.quiz_complete:
        st.write(f"**Question {st.session_state.current_question + 1} of 5**")
        
        # Generate new question if needed
        if st.session_state.current_question >= len(st.session_state.questions):
            with st.spinner("Generating question..."):
                max_attempts = 3
                for attempt in range(max_attempts):
                    question_response = generate_question("history", st.session_state.used_questions)
                    question_data = parse_question_response(question_response)
                    
                    # Validate the question
                    if validate_question_data(question_data):
                        # Store the question text to avoid duplicates
                        if question_data['question']:
                            st.session_state.used_questions.append(question_data['question'])
                            st.session_state.questions.append(question_data)
                            break
                    else:
                        st.warning(f"Attempt {attempt + 1} failed to generate valid question. Retrying...")
                        if attempt == max_attempts - 1:
                            st.error("Failed to generate a valid question. Please try again.")
                            return
        
        # Display current question
        if (st.session_state.current_question < len(st.session_state.questions) and 
            st.session_state.current_question < 5):
            
            current_q = st.session_state.questions[st.session_state.current_question]
            
            if validate_question_data(current_q):
                st.subheader(current_q['question'])
                
                # Display options
                options = ['a', 'b', 'c', 'd']
                option_texts = []
                for opt in options:
                    if current_q.get(opt):
                        option_texts.append(f"{opt}) {current_q[opt]}")
                
                if option_texts:
                    user_choice = st.radio(
                        "Select your answer:",
                        options,
                        format_func=lambda x: f"{x}) {current_q.get(x, '')}"
                    )
                    
                    if st.button("Submit Answer"):
                        is_correct = check_answer(current_q, user_choice)
                        st.session_state.user_answers.append({
                            'question': current_q['question'],
                            'user_answer': user_choice,
                            'correct_answer': current_q.get('correct', ''),
                            'is_correct': is_correct
                        })
                        
                        # Show immediate feedback
                        if is_correct:
                            st.success("Correct! 🎉")
                        else:
                            st.error(f"Incorrect. The correct answer is {current_q.get('correct', '').upper()}.")
                        
                        st.session_state.current_question += 1
                        
                        # Check if quiz is complete
                        if st.session_state.current_question >= 5:
                            st.session_state.quiz_complete = True
                        
                        st.rerun()
                else:
                    st.error("No valid options found for this question.")
            else:
                st.error("Invalid question generated. Please try starting the quiz again.")
                if st.button("Restart Quiz"):
                    st.session_state.quiz_started = False
                    st.rerun()
    
    # Quiz complete - show results
    elif st.session_state.quiz_complete:
        st.header("Quiz Complete!")
        
        correct_count = sum(1 for answer in st.session_state.user_answers if answer['is_correct'])
        st.subheader(f"Your Score: {correct_count}/5")
        
        # Display results for each question
        st.write("### Detailed Results:")
        for i, answer in enumerate(st.session_state.user_answers):
            with st.expander(f"Question {i+1}: {answer['question'][:50]}..."):
                st.write(f"**Question:** {answer['question']}")
                st.write(f"**Your answer:** {answer['user_answer'].upper()}")
                st.write(f"**Correct answer:** {answer['correct_answer'].upper()}")
                if answer['is_correct']:
                    st.success("✓ Correct")
                else:
                    st.error("✗ Incorrect")
        
        # Generate feedback
        if st.session_state.user_answers:
            performance = "excellent" if correct_count >= 4 else "good" if correct_count >= 3 else "needs improvement"
            feedback_prompt = f"""
            The user scored {correct_count} out of 5 on a history quiz. 
            This is {performance} performance. 
            Provide brief, encouraging feedback about their history knowledge in 2-3 sentences.
            Be positive and constructive.
            """
            
            with st.spinner("Generating feedback..."):
                try:
                    feedback_response = llm.invoke([HumanMessage(content=feedback_prompt)])
                    st.subheader("Feedback:")
                    st.write(feedback_response.content)
                except Exception as e:
                    st.write("Great job completing the quiz! Keep learning about history!")
        
        st.write("---")
        if st.button("Start New Quiz"):
            st.session_state.quiz_started = False
            st.session_state.quiz_complete = False
            st.rerun()

if __name__ == "__main__":
    main()