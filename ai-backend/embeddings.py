import pandas as pd
import numpy as np
from sentence_transformers import SentenceTransformer

# ==========================================
# CONFIG
# ==========================================

INPUT_CSV = "skill_features_engineered.csv"   # path to your CSV
TEXT_COLUMN = "skill"                        # CHANGE to your text column
OUTPUT_EMB_FILE = "embeddings.npy"
OUTPUT_INDEX_FILE = "embedding_index.csv"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

# ==========================================
# LOAD CSV
# ==========================================

df = pd.read_csv(INPUT_CSV)

if TEXT_COLUMN not in df.columns:
    raise ValueError(f"Column '{TEXT_COLUMN}' not found in CSV")

# Preserve original index
df["original_index"] = df.index

texts = df[TEXT_COLUMN].astype(str).tolist()

# ==========================================
# LOAD MODEL
# ==========================================

print("Loading model...")
model = SentenceTransformer(MODEL_NAME)

# ==========================================
# GENERATE EMBEDDINGS
# ==========================================

print("Generating embeddings...")
embeddings = model.encode(
    texts,
    batch_size=32,
    show_progress_bar=True,
    convert_to_numpy=True,
    normalize_embeddings=True  # recommended for cosine similarity
)

print("Embeddings shape:", embeddings.shape)

# ==========================================
# SAVE OUTPUT
# ==========================================

# Save embeddings as .npy
np.save(OUTPUT_EMB_FILE, embeddings)

# Save index mapping (so you know which row corresponds to which vector)
df[["original_index", TEXT_COLUMN]].to_csv(OUTPUT_INDEX_FILE, index=False)

print("Done ✅")
print(f"Embeddings saved to: {OUTPUT_EMB_FILE}")
print(f"Index mapping saved to: {OUTPUT_INDEX_FILE}")