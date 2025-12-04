import sys
import os

# Add current directory to path so our mock module is found first
sys.path.insert(0, os.path.dirname(__file__))

from fer import FER
import cv2

detector = FER(mtcnn=False)
cap = cv2.VideoCapture(0)

while True:
    ret, frame = cap.read()
    if not ret:
        break

    results = detector.detect_emotions(frame)
    
    for result in results:
        (x, y, w, h) = result["box"]
        emotions = result["emotions"]
        dominant_emotion = max(emotions, key=emotions.get)
        
        cv2.rectangle(frame, (x, y), (x+w, y+h), (0, 255, 0), 2)
        cv2.putText(frame, dominant_emotion, (x, y-10), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 0), 2)

    cv2.imshow('Emotion Detection', frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()